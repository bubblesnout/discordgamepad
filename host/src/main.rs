//! DiscordHost: launch Discord and mirror it into a fullscreen, game-style
//! Direct3D 11 window, so the Steam overlay has a normal swapchain to attach to.
//!
//! Steam launches this exe instead of Discord. Pipeline per frame:
//!   Windows.Graphics.Capture (Discord's window, GPU texture)
//!     -> CopySubresourceRegion into our flip-model swapchain -> Present(1)
//! Everything stays on the GPU; the only added latency is waiting for vsync.
//! Mouse/touch/keyboard sent to our window is re-posted to Discord's window.

#![windows_subsystem = "windows"]

use std::fs::OpenOptions;
use std::os::windows::process::CommandExt as _; // CREATE_NO_WINDOW: no console flashes
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::{Duration, Instant};

use windows::core::{factory, w, Interface, Result, HSTRING, PCWSTR};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{ClientToScreen, ScreenToClient};
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{FrameworkInputPane, IFrameworkInputPane, ITaskbarList2, TaskbarList};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::*;

static DISCORD: AtomicIsize = AtomicIsize::new(0);

/// Pixels of Discord's own window frame hidden off each screen edge.
const CROP: i32 = 2;

/// How far the picture is shifted up (px) while the touch keyboard is open.
/// Discord can't shrink below ~500 DIP tall, so instead of resizing it we
/// slide the whole image up so its message box sits just above the keyboard.
static SHIFT: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// Flags that keep Discord rendering at full rate while our window covers it.
const DISCORD_FLAGS: &[&str] = &[
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
];

fn log(msg: impl AsRef<str>) {
    let path = std::env::current_exe().unwrap_or_default().with_file_name("DiscordHost.log");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{:?} {}", std::time::SystemTime::now(), msg.as_ref());
    }
}

fn fatal(msg: &str) -> ! {
    log(format!("FATAL: {msg}"));
    unsafe { MessageBoxW(None, &HSTRING::from(msg), w!("DiscordHost"), MB_OK | MB_ICONERROR) };
    std::process::exit(1);
}

/* ---------------- finding / launching Discord ---------------- */

/// %LOCALAPPDATA%\Discord\app-<newest>\Discord.exe
fn newest_discord_exe() -> Option<PathBuf> {
    let base = PathBuf::from(std::env::var("LOCALAPPDATA").ok()?).join("Discord");
    let mut best: Option<(Vec<u32>, PathBuf)> = None;
    for e in std::fs::read_dir(&base).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(ver) = name.strip_prefix("app-") else { continue };
        let exe = e.path().join("Discord.exe");
        if !exe.exists() { continue; }
        let v: Vec<u32> = ver.split('.').filter_map(|p| p.parse().ok()).collect();
        if best.as_ref().map_or(true, |(bv, _)| v > *bv) { best = Some((v, exe)); }
    }
    best.map(|(_, p)| p)
}

fn process_name(hwnd: HWND) -> String {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if ok { String::from_utf16_lossy(&buf[..len as usize]) } else { String::new() }
    }
}

/// Discord's main window: a Chromium top-level window owned by Discord.exe,
/// not the small "Discord Updater" splash. Picks the largest candidate.
fn find_discord_window() -> Option<HWND> {
    struct Acc { best: Option<(i64, HWND)> }
    unsafe extern "system" fn cb(hwnd: HWND, lp: LPARAM) -> BOOL {
        let acc = &mut *(lp.0 as *mut Acc);
        if !IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() { return TRUE; }
        let mut cls = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut cls);
        if String::from_utf16_lossy(&cls[..n as usize]) != "Chrome_WidgetWin_1" { return TRUE; }
        let mut title = [0u16; 256];
        let tn = GetWindowTextW(hwnd, &mut title);
        let title = String::from_utf16_lossy(&title[..tn as usize]);
        if title.is_empty() || title.contains("Updater") { return TRUE; }
        if !process_name(hwnd).to_ascii_lowercase().ends_with("\\discord.exe") { return TRUE; }
        let mut r = RECT::default();
        let _ = GetWindowRect(hwnd, &mut r);
        let area = ((r.right - r.left) as i64) * ((r.bottom - r.top) as i64);
        if acc.best.map_or(true, |(a, _)| area > a) { acc.best = Some((area, hwnd)); }
        TRUE
    }
    let mut acc = Acc { best: None };
    unsafe { let _ = EnumWindows(Some(cb), LPARAM(&mut acc as *mut _ as isize)); }
    acc.best.map(|(_, h)| h)
}

fn discord_running() -> bool {
    let out = std::process::Command::new("tasklist").creation_flags(0x0800_0000)
        .args(["/FI", "IMAGENAME eq Discord.exe", "/NH"])
        .output();
    out.map(|o| String::from_utf8_lossy(&o.stdout).contains("Discord.exe")).unwrap_or(false)
}

fn launch_discord() {
    let Some(exe) = newest_discord_exe() else { fatal("Couldn't find Discord in %LOCALAPPDATA%\\Discord") };
    // Discord is single-instance: an already-running copy (e.g. from the tray)
    // would ignore our flags, so restart it with them.
    if discord_running() && !std::env::args().any(|a| a == "--keep-running") {
        log("Discord already running; restarting it with host flags");
        let _ = std::process::Command::new("taskkill").creation_flags(0x0800_0000).args(["/IM", "Discord.exe", "/F"]).output();
        std::thread::sleep(Duration::from_millis(1500));
    }
    log(format!("launching {}", exe.display()));
    let dir = exe.parent().unwrap().to_path_buf();
    if let Err(e) = std::process::Command::new(&exe).args(DISCORD_FLAGS).current_dir(dir).spawn() {
        fatal(&format!("Couldn't start Discord: {e}"));
    }
}

fn wait_for_discord(timeout: Duration) -> Option<HWND> {
    let end = Instant::now() + timeout;
    while Instant::now() < end {
        if let Some(h) = find_discord_window() {
            let mut r = RECT::default();
            unsafe { let _ = GetWindowRect(h, &mut r); }
            if r.right - r.left > 600 { return Some(h); }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    None
}

/* ---------------- our window ---------------- */

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let discord = HWND(DISCORD.load(Ordering::Relaxed) as _);
    match msg {
        WM_DESTROY => { PostQuitMessage(0); LRESULT(0) }
        WM_SETCURSOR => { SetCursor(LoadCursorW(None, IDC_ARROW).unwrap_or_default()); LRESULT(1) }
        // Re-post input to Discord. Its window sits exactly under ours, so
        // client coordinates line up 1:1.
        WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP | WM_LBUTTONDBLCLK
        | WM_RBUTTONDOWN | WM_RBUTTONUP | WM_MBUTTONDOWN | WM_MBUTTONUP
        | WM_MOUSEWHEEL | WM_MOUSEHWHEEL
        | WM_KEYDOWN | WM_KEYUP | WM_CHAR | WM_SYSKEYDOWN | WM_SYSKEYUP | WM_SYSCHAR
            if !discord.is_invalid() =>
        {
            // Alt+F4 still closes us.
            if msg == WM_SYSKEYDOWN && wp.0 == 0x73 { return DefWindowProcW(hwnd, msg, wp, lp); }
            let is_client_mouse = (WM_MOUSEMOVE..=WM_MBUTTONDBLCLK).contains(&msg) && msg != WM_MOUSEWHEEL;
            let is_wheel = msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL; // screen coords
            let lp = if is_client_mouse { to_discord_client(discord, hwnd, lp) }
                else if is_wheel {
                    let x = (lp.0 & 0xffff) as i16 as i32;
                    let y = ((lp.0 >> 16) & 0xffff) as i16 as i32 + SHIFT.load(Ordering::Relaxed);
                    LPARAM(((y as u16 as isize) << 16) | (x as u16 as isize))
                } else { lp };
            let _ = PostMessageW(discord, msg, wp, lp);
            LRESULT(0)
        }
        WM_ACTIVATE => {
            // Topmost only while we're the active app: that keeps us above the
            // handheld pull-out taskbar, but lets Big Picture / other apps
            // come in front when you switch away.
            let active = (wp.0 & 0xffff) as u32 != WA_INACTIVE;
            let _ = SetWindowPos(hwnd, if active { HWND_TOPMOST } else { HWND_NOTOPMOST }, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            // let Chromium believe it's the active window so carets/focus work
            if !discord.is_invalid() { let _ = PostMessageW(discord, WM_ACTIVATE, wp, LPARAM(0)); }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

fn create_window() -> Result<(HWND, RECT)> {
    unsafe {
        let inst = GetModuleHandleW(None)?;
        let class = w!("DiscordHostWindow");
        let wc = WNDCLASSW {
            style: CS_DBLCLKS,
            lpfnWndProc: Some(wndproc),
            hInstance: inst.into(),
            lpszClassName: class,
            hIcon: LoadIconW(inst, PCWSTR(1 as _)).unwrap_or_default(),
            ..Default::default()
        };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(
            WS_EX_APPWINDOW, class, w!("Discord"), WS_POPUP,
            0, 0, 100, 100, None, None, inst, None,
        )?;
        // fullscreen on the primary monitor
        let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(mon, &mut mi);
        let r = mi.rcMonitor;
        SetWindowPos(hwnd, None, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_SHOWWINDOW)?;
        let _ = SetForegroundWindow(hwnd);
        // Tell the shell we're a fullscreen app so the taskbar stays below us.
        if let Ok(tb) = CoCreateInstance::<_, ITaskbarList2>(&TaskbarList, None, CLSCTX_ALL) {
            if tb.HrInit().is_ok() { let _ = tb.MarkFullscreenWindow(hwnd, true); }
        }
        Ok((hwnd, r))
    }
}

/// Take keyboard focus/foreground from whoever has it. Plain SetForegroundWindow
/// is refused once another process (Discord, right after launch) owns the
/// foreground, so briefly attach to that thread's input queue first.
fn take_foreground(host: HWND) {
    unsafe {
        let fg = GetForegroundWindow();
        let _ = BringWindowToTop(host);
        if fg == host { return; }
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let me = windows::Win32::System::Threading::GetCurrentThreadId();
        let attached = fg_thread != 0 && fg_thread != me && windows::Win32::System::Threading::AttachThreadInput(me, fg_thread, true).as_bool();
        let _ = BringWindowToTop(host);
        let _ = SetForegroundWindow(host);
        let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(host);
        if attached { let _ = windows::Win32::System::Threading::AttachThreadInput(me, fg_thread, false); }
    }
}

/// Stop Discord's window from ever being activated (clicks, its own focus
/// calls). The Steam overlay only shows on the focused window, which must be ours.
fn make_noactivate(discord: HWND) {
    unsafe {
        let ex = GetWindowLongPtrW(discord, GWL_EXSTYLE);
        if ex & WS_EX_NOACTIVATE.0 as isize == 0 {
            SetWindowLongPtrW(discord, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize);
        }
    }
}

/// Put Discord exactly under our window, same size, never minimised
/// (a minimised window stops rendering, and capture would freeze).
/// Windows 11 windows have invisible resize borders, and the capture only
/// covers the visible frame, so grow the window by those borders until the
/// visible frame matches the monitor exactly.
fn place_discord(discord: HWND, host: HWND, r: RECT) {
    unsafe {
        // Never activate Discord here: the host must keep focus, or touch and
        // controller input break. Un-maximize without activating if needed.
        if IsIconic(discord).as_bool() || IsZoomed(discord).as_bool() { let _ = ShowWindow(discord, SW_SHOWNOACTIVATE); }
        // Discord draws a thin frame when not maximized: make the window CROP px
        // larger on every side so that frame sits off-screen; present() crops it.
        let r = RECT { left: r.left - CROP, top: r.top - CROP, right: r.right + CROP, bottom: r.bottom + CROP };
        let mut wr = RECT::default();
        let mut fb = RECT::default();
        let _ = GetWindowRect(discord, &mut wr);
        let ok = DwmGetWindowAttribute(discord, DWMWA_EXTENDED_FRAME_BOUNDS, &mut fb as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32).is_ok();
        let (l, t, rr, b) = if ok { (fb.left - wr.left, fb.top - wr.top, wr.right - fb.right, wr.bottom - fb.bottom) } else { (0, 0, 0, 0) };
        let (x, y, w, h) = (r.left - l, r.top - t, (r.right - r.left) + l + rr, (r.bottom - r.top) + t + b);
        let off = (wr.left - x).abs().max((wr.top - y).abs()).max((wr.right - wr.left - w).abs()).max((wr.bottom - wr.top - h).abs());
        if off > 6 {
            log(format!("resize discord {:?} -> ({x},{y},{w},{h})", (wr.left, wr.top, wr.right - wr.left, wr.bottom - wr.top)));
            let _ = SetWindowPos(discord, host, x, y, w, h, SWP_NOACTIVATE);
        } else {
            let _ = SetWindowPos(discord, host, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
        }
    }
}

/// The on-screen touch keyboard's rect, if it's showing.
fn touch_keyboard_rect(pane: &Option<IFrameworkInputPane>) -> Option<RECT> {
    let r = unsafe { pane.as_ref()?.Location().ok()? };
    (r.bottom - r.top > 50).then_some(r)
}

/// Pixels to slide the picture up so Discord's bottom edge meets the
/// keyboard's top edge (0 when the keyboard is hidden).
fn keyboard_shift(monitor: RECT, pane: &Option<IFrameworkInputPane>) -> i32 {
    let Some(kb) = touch_keyboard_rect(pane) else { return 0 };
    // A docked keyboard spans the screen width. If it reports narrower,
    // it's in DIPs: scale it back to physical pixels.
    let mw = (monitor.right - monitor.left) as f64;
    let kw = (kb.right - kb.left).max(1) as f64;
    let scale = if kw < mw * 0.95 && kw > mw * 0.4 { mw / kw } else { 1.0 };
    let top = monitor.top + (((kb.top - monitor.top) as f64) * scale).round() as i32;
    if top <= monitor.top + 100 || top >= monitor.bottom { return 0; }
    monitor.bottom - top
}

/// Screen point -> Discord client coordinates (for re-posted mouse messages).
fn to_discord_client(discord: HWND, host: HWND, lp: LPARAM) -> LPARAM {
    unsafe {
        let mut p = POINT { x: (lp.0 & 0xffff) as i16 as i32, y: ((lp.0 >> 16) & 0xffff) as i16 as i32 };
        let _ = ClientToScreen(host, &mut p);
        let _ = ScreenToClient(discord, &mut p);
        p.y += SHIFT.load(Ordering::Relaxed);
        LPARAM(((p.y as u16 as isize) << 16) | (p.x as u16 as isize))
    }
}

/* ---------------- D3D + capture ---------------- */

struct Gfx {
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    swap: IDXGISwapChain1,
    width: u32,
    height: u32,
    last: Option<ID3D11Texture2D>,
}

fn create_gfx(hwnd: HWND, w: u32, h: u32) -> Result<Gfx> {
    unsafe {
        let mut device = None;
        let mut ctx = None;
        D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut ctx))?;
        let device: ID3D11Device = device.unwrap();
        let factory: IDXGIFactory2 = CreateDXGIFactory1()?;
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: w,
            Height: h,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            Scaling: DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
            AlphaMode: DXGI_ALPHA_MODE_IGNORE,
            Flags: 0,
            ..Default::default()
        };
        let swap = factory.CreateSwapChainForHwnd(&device, hwnd, &desc, None, None)?;
        Ok(Gfx { device, ctx: ctx.unwrap(), swap, width: w, height: h, last: None })
    }
}

fn winrt_device(device: &ID3D11Device) -> Result<IDirect3DDevice> {
    let dxgi: IDXGIDevice = device.cast()?;
    unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast() }
}

struct Capture {
    pool: Direct3D11CaptureFramePool,
    _session: GraphicsCaptureSession,
    size: SizeInt32,
    rt_device: IDirect3DDevice,
}

fn start_capture(gfx: &Gfx, discord: HWND) -> Result<Capture> {
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(discord)? };
    let size = item.Size()?;
    let rt_device = winrt_device(&gfx.device)?;
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&rt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)?;
    let session = pool.CreateCaptureSession(&item)?;
    let _ = session.SetIsBorderRequired(false); // Windows 11: no yellow border
    let _ = session.SetIsCursorCaptureEnabled(false);
    session.StartCapture()?;
    Ok(Capture { pool, _session: session, size, rt_device })
}

/// Pull the newest captured frame (if any) into `gfx.last`.
fn pull_frame(gfx: &mut Gfx, cap: &mut Capture) -> Result<bool> {
    let mut got = false;
    // drain to the newest frame
    while let Ok(frame) = cap.pool.TryGetNextFrame() {
        let size = frame.ContentSize()?;
        let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
        let tex: ID3D11Texture2D = unsafe { access.GetInterface()? };
        unsafe {
            let mut d = D3D11_TEXTURE2D_DESC::default();
            tex.GetDesc(&mut d);
            let need_new = match &gfx.last {
                Some(l) => { let mut ld = D3D11_TEXTURE2D_DESC::default(); l.GetDesc(&mut ld); ld.Width != d.Width || ld.Height != d.Height }
                None => true,
            };
            if need_new {
                d.Usage = D3D11_USAGE_DEFAULT;
                d.BindFlags = 0;
                d.CPUAccessFlags = 0;
                d.MiscFlags = 0;
                let mut t = None;
                gfx.device.CreateTexture2D(&d, None, Some(&mut t))?;
                gfx.last = t;
            }
            gfx.ctx.CopyResource(gfx.last.as_ref().unwrap(), &tex);
        }
        if size.Width != cap.size.Width || size.Height != cap.size.Height {
            cap.size = size;
            cap.pool.Recreate(&cap.rt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)?;
        }
        got = true;
    }
    Ok(got)
}

fn present(gfx: &Gfx, content: SizeInt32) -> Result<()> {
    unsafe {
        let back: ID3D11Texture2D = gfx.swap.GetBuffer(0)?;
        let rtv = {
            let mut v = None;
            gfx.device.CreateRenderTargetView(&back, None, Some(&mut v))?;
            v.unwrap()
        };
        gfx.ctx.ClearRenderTargetView(&rtv, &[0.0, 0.0, 0.0, 1.0]);
        if let Some(last) = &gfx.last {
            let c = CROP as u32;
            let shift = SHIFT.load(Ordering::Relaxed).max(0) as u32;
            let w = (content.Width.max(0) as u32).saturating_sub(2 * c).min(gfx.width);
            let h = (content.Height.max(0) as u32).saturating_sub(2 * c + shift).min(gfx.height);
            let bx = D3D11_BOX { left: c, top: c + shift, front: 0, right: c + w, bottom: c + shift + h, back: 1 };
            let (dx, dy) = ((gfx.width - w) / 2, 0);
            gfx.ctx.CopySubresourceRegion(&back, 0, dx, dy, 0, last, 0, Some(&bx));
        }
        // vsync-paced; keeps presenting even when Discord is idle so the
        // Steam overlay (which draws on Present) stays responsive
        gfx.swap.Present(1, DXGI_PRESENT(0)).ok()
    }
}

/* ---------------- controller forwarding ---------------- */

/// Chromium only feeds the Gamepad API to the focused window, which is ours,
/// so read the pad here and send it to the GamepadNav plugin over localhost UDP.
struct PadSender { sock: Option<std::net::UdpSocket>, slot: u32, last_scan: Instant }

impl PadSender {
    fn new() -> Self {
        let sock = std::net::UdpSocket::bind("127.0.0.1:0").ok();
        Self { sock, slot: 0, last_scan: Instant::now() - Duration::from_secs(10) }
    }

    fn send(&mut self) {
        use windows::Win32::UI::Input::XboxController::{XInputGetState, XINPUT_STATE};
        let Some(sock) = &self.sock else { return };
        let mut st = XINPUT_STATE::default();
        let mut ok = unsafe { XInputGetState(self.slot, &mut st) } == 0;
        // the pad may sit on another slot (e.g. Steam Input's virtual pad); rescan occasionally
        if !ok && self.last_scan.elapsed() > Duration::from_secs(1) {
            self.last_scan = Instant::now();
            for i in 0..4 {
                if unsafe { XInputGetState(i, &mut st) } == 0 { self.slot = i; ok = true; log(format!("controller on XInput slot {i}")); break; }
            }
        }
        if !ok { return; }
        let g = st.Gamepad;
        let mut b = [0u8; 12];
        b[0..2].copy_from_slice(&g.wButtons.0.to_le_bytes());
        b[2] = g.bLeftTrigger;
        b[3] = g.bRightTrigger;
        b[4..6].copy_from_slice(&g.sThumbLX.to_le_bytes());
        b[6..8].copy_from_slice(&g.sThumbLY.to_le_bytes());
        b[8..10].copy_from_slice(&g.sThumbRX.to_le_bytes());
        b[10..12].copy_from_slice(&g.sThumbRY.to_le_bytes());
        let _ = sock.send_to(&b, "127.0.0.1:47823");
    }
}

/* ---------------- main ---------------- */

fn main() {
    unsafe { let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }
    log("---- DiscordHost start");
    unsafe { let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED); }
    let pane: Option<IFrameworkInputPane> = unsafe { CoCreateInstance(&FrameworkInputPane, None, CLSCTX_ALL).ok() };

    let (hwnd, rect) = create_window().unwrap_or_else(|e| fatal(&format!("window: {e}")));
    let w = (rect.right - rect.left) as u32;
    let h = (rect.bottom - rect.top) as u32;
    let mut gfx = create_gfx(hwnd, w, h).unwrap_or_else(|e| fatal(&format!("d3d: {e}")));
    let _ = present(&gfx, SizeInt32::default()); // black while Discord starts

    let discord = match find_discord_window().filter(|_| std::env::args().any(|a| a == "--keep-running")) {
        Some(d) => d,
        None => {
            launch_discord();
            wait_for_discord(Duration::from_secs(60)).unwrap_or_else(|| fatal("Discord's window never appeared"))
        }
    };
    log(format!("discord hwnd {:?}", discord.0));
    DISCORD.store(discord.0 as isize, Ordering::Relaxed);
    place_discord(discord, hwnd, rect);
    make_noactivate(discord);
    take_foreground(hwnd);

    let mut cap = start_capture(&gfx, discord).unwrap_or_else(|e| fatal(&format!("capture: {e}")));
    log(format!("capturing {}x{} into {}x{}", cap.size.Width, cap.size.Height, w, h));
    let above = unsafe { GetWindow(hwnd, GW_HWNDPREV).ok() } ;
    log(format!("window above host: {:?}", above.map(|h| h.0)));
    let overlay = unsafe { GetModuleHandleW(w!("gameoverlayrenderer64.dll")).is_ok() };
    log(format!("steam overlay dll loaded: {overlay}"));
    let mut last_fg = HWND::default();

    let mut pad = PadSender::new();
    let mut discord_gone = false;
    let mut last_place = Instant::now();
    let mut last_check = Instant::now();
    'outer: loop {
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT { break 'outer; }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if !IsWindow(discord).as_bool() { log("Discord window closed"); discord_gone = true; break; }
            // If Discord grabs focus (e.g. its own maximize button), take it back:
            // input only reaches it correctly through the host.
            let fg = GetForegroundWindow();
            if fg != last_fg {
                let mut cls = [0u16; 64];
                let n = GetClassNameW(fg, &mut cls);
                log(format!("foreground -> {:?} {} ({})", fg.0, String::from_utf16_lossy(&cls[..n as usize]), process_name(fg)));
                last_fg = fg;
            }
            if fg == discord { take_foreground(hwnd); }
        }
        // Discord sometimes moves/resizes itself (e.g. restoring from tray)
        // Resizing Discord cancels in-progress taps, so only do it when the
        // target actually changes (keyboard up/down), or every few seconds
        // in case Discord moved itself.
        if last_place.elapsed() > Duration::from_millis(100) {
            let shift = keyboard_shift(rect, &pane);
            if shift != SHIFT.load(Ordering::Relaxed) {
                let raw = touch_keyboard_rect(&pane).map(|k| (k.left, k.top, k.right, k.bottom));
                log(format!("keyboard {raw:?} -> shift {shift}"));
                SHIFT.store(shift, Ordering::Relaxed);
            }
            if last_check.elapsed() > Duration::from_secs(1) {
                place_discord(discord, hwnd, rect);
                last_check = Instant::now();
            }
            last_place = Instant::now();
        }
        // only while we're focused: when the Steam overlay or another app is
        // in front, the controller belongs to them
        if unsafe { GetForegroundWindow() } == hwnd { pad.send(); }
        if let Err(e) = pull_frame(&mut gfx, &mut cap) { log(format!("frame: {e}")); }
        if let Err(e) = present(&gfx, cap.size) { log(format!("present: {e}")); std::thread::sleep(Duration::from_millis(16)); }
    }
    // Host closed (Alt+F4, Steam "Exit game"): take Discord down with us.
    if !discord_gone { quit_discord(); }
    log("exit");
}

/// Ask the GamepadNav plugin to quit Discord properly; force it if that fails.
fn quit_discord() {
    log("host closed: quitting Discord");
    if let Ok(sock) = std::net::UdpSocket::bind("127.0.0.1:0") {
        let _ = sock.send_to(b"QUIT", "127.0.0.1:47823");
    }
    let end = Instant::now() + Duration::from_secs(4);
    while Instant::now() < end {
        if !discord_running() { return; }
        std::thread::sleep(Duration::from_millis(200));
    }
    log("Discord didn't quit; forcing it");
    let _ = std::process::Command::new("taskkill").creation_flags(0x0800_0000).args(["/IM", "Discord.exe", "/F"]).output();
}

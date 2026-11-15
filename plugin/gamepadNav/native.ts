/*
 * GamepadNav (Electron main process helpers).
 * Each function's first argument is the IPC event from the calling renderer.
 */

import type { IpcMainInvokeEvent } from "electron";

/** Fully quit Discord (not just hide to tray). */
export function quitDiscord() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("electron").app.quit();
}

/**
 * True fullscreen (like F11) for the calling window. Puts Discord above the
 * handheld pull-out taskbar, which a maximised window doesn't cover.
 */
export function setFullscreen(e: IpcMainInvokeEvent, on: boolean) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BrowserWindow } = require("electron");
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && win.isFullScreen() !== on) win.setFullScreen(on);
}

/* ---------- Windows touch keyboard ---------- */

// A focused text box only gets the Windows touch keyboard automatically when
// it's tapped. For A on the controller we toggle it through the shell's
// ITipInvocation COM interface. The same helper also asks Windows where the
// keyboard is (IFrameworkInputPane.Location) every 100 ms and prints
// "KB <height-in-physical-px>" when it changes: Chromium's own keyboard
// reports turned out to be unreliable. The helper is a PowerShell process
// started once and kept running, so both are instant.
const TIP_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("37c994e7-432b-4834-a2f7-dce1f13b834b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITipInvocation { void Toggle(IntPtr hwnd); }
[StructLayout(LayoutKind.Sequential)] public struct GpnRect { public int Left, Top, Right, Bottom; }
[ComImport, Guid("5752238B-24F0-495A-82F1-2FD593056796"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFrameworkInputPane {
    void Advise(IntPtr a, IntPtr b, out int c);
    void AdviseWithHWND(IntPtr a, IntPtr b, out int c);
    void Unadvise(int c);
    void Location(out GpnRect r);
}
public static class GpnTip {
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    static IFrameworkInputPane pane;
    public static void Toggle() {
        var t = Type.GetTypeFromCLSID(new Guid("4ce576fa-83dc-4F88-951c-9d0782b4e376"));
        var o = (ITipInvocation)Activator.CreateInstance(t);
        o.Toggle(GetDesktopWindow());
        Marshal.ReleaseComObject(o);
    }
    public static int Height() {
        try {
            if (pane == null) pane = (IFrameworkInputPane)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("D5120AA3-46BA-44C5-822D-CA8092C1FC72")));
            GpnRect r; pane.Location(out r);
            return r.Bottom - r.Top;
        } catch { pane = null; return 0; }
    }
}
'@
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput())  # real async reads; Console.In blocks
$task = $in.ReadLineAsync()
$last = -1
while ($true) {
    if ($task.IsCompleted) {
        if ($task.Result -eq $null) { break }
        try { [GpnTip]::Toggle() } catch {
            Start-Process "$env:CommonProgramFiles\microsoft shared\ink\TabTip.exe"
            Start-Sleep -Milliseconds 600
            try { [GpnTip]::Toggle() } catch {}
        }
        $task = $in.ReadLineAsync()
    }
    $h = [GpnTip]::Height()
    if ($h -ne $last) { [Console]::Out.WriteLine("KB $h"); [Console]::Out.Flush(); $last = $h }
    Start-Sleep -Milliseconds 100
}
`;

let kbPhysical = 0;

let tip: import("child_process").ChildProcess | null = null;

function tipHelper() {
    if (tip && tip.exitCode === null) return tip;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require("child_process") as typeof import("child_process");
    const encoded = Buffer.from(TIP_SCRIPT, "utf16le").toString("base64");
    tip = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
    });
    let buf = "";
    tip.stdout?.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split(String.fromCharCode(10));
        buf = lines.pop() ?? "";
        for (const l of lines) {
            const m = /^KB (-?\d+)/.exec(l.trim());
            if (m) kbPhysical = Math.max(0, +m[1]);
        }
    });
    tip.on("exit", () => { tip = null; kbPhysical = 0; });
    return tip;
}

/** Start the helper early so the first A press doesn't wait for PowerShell. */
export function warmTouchKeyboard() {
    tipHelper();
}

/** Toggle the Windows touch keyboard (call only when it's hidden). */
export function toggleTouchKeyboard() {
    tipHelper().stdin?.write("toggle\n");
}

/** Touch keyboard height in physical pixels (0 = hidden), as Windows reports it. */
export function getKeyboardHeight() {
    tipHelper();
    return kbPhysical;
}

export function stopTouchKeyboard() {
    tip?.kill();
    tip = null;
}

/* ---------- local fonts ---------- */

const WEIGHTS: [RegExp, number][] = [
    [/thin|hairline/i, 100], [/extralight|ultralight/i, 200], [/light/i, 300],
    [/extrabold|ultrabold/i, 800], [/semibold|demibold/i, 600], [/bold/i, 700],
    [/medium/i, 500], [/black|heavy/i, 900],
];

/**
 * Fonts dropped into the repo's (git-ignored) fonts/ folder, e.g. Motiva Sans.
 * File names like "MotivaSansBold.woff.ttf" become family "Motiva Sans", weight 700.
 * The built main-process bundle lives in <repo>/vencord/dist.
 */
export function listLocalFonts(): { family: string; weight: number; data: Uint8Array; }[] {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    /* eslint-enable */
    const dir = path.resolve(__dirname, "..", "..", "fonts");
    if (!fs.existsSync(dir)) return [];
    const out: { family: string; weight: number; data: Uint8Array; }[] = [];
    for (const file of fs.readdirSync(dir)) {
        if (!/\.(ttf|otf|woff2?)$/i.test(file)) continue;
        const base = file.replace(/(\.woff2?|\.ttf|\.otf)+$/i, "");
        const wm = WEIGHTS.find(([re]) => re.test(base));
        const weight = wm?.[1] ?? 400;
        const familyRaw = base.replace(/[-_ ]?(thin|hairline|extralight|ultralight|light|regular|book|normal|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy)$/i, "");
        const family = familyRaw.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").trim();
        try {
            out.push({ family, weight, data: new Uint8Array(fs.readFileSync(path.join(dir, file))) });
        } catch { /* unreadable file: skip */ }
    }
    return out;
}

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
// ITipInvocation COM interface, from a PowerShell helper that's started once
// and kept waiting on stdin, so showing the keyboard is instant.
const TIP_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("37c994e7-432b-4834-a2f7-dce1f13b834b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITipInvocation { void Toggle(IntPtr hwnd); }
public static class GpnTip {
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    public static void Toggle() {
        var t = Type.GetTypeFromCLSID(new Guid("4ce576fa-83dc-4F88-951c-9d0782b4e376"));
        var o = (ITipInvocation)Activator.CreateInstance(t);
        o.Toggle(GetDesktopWindow());
        Marshal.ReleaseComObject(o);
    }
}
'@
while (($line = [Console]::In.ReadLine()) -ne $null) {
    try { [GpnTip]::Toggle() } catch {
        Start-Process "$env:CommonProgramFiles\microsoft shared\ink\TabTip.exe"
        Start-Sleep -Milliseconds 600
        try { [GpnTip]::Toggle() } catch {}
    }
}
`;

let tip: import("child_process").ChildProcess | null = null;

function tipHelper() {
    if (tip && tip.exitCode === null) return tip;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require("child_process") as typeof import("child_process");
    const encoded = Buffer.from(TIP_SCRIPT, "utf16le").toString("base64");
    tip = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"],
    });
    tip.on("exit", () => { tip = null; });
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

export function stopTouchKeyboard() {
    tip?.kill();
    tip = null;
}

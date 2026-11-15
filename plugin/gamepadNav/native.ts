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

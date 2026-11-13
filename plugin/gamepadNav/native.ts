/*
 * GamepadNav (Electron main process): receives controller state from
 * DiscordHost.exe over localhost UDP. Chromium only gives Gamepad API input to
 * the focused window, and under the Steam host that's the host, not Discord.
 *
 * Packet (12 bytes, little endian): u16 buttons (XInput bits), u8 LT, u8 RT,
 * i16 LX, i16 LY, i16 RX, i16 RY.
 */

import { createSocket, Socket } from "dgram";

const HOST_PAD_PORT = 47823;

let sock: Socket | null = null;
let last: number[] | null = null;
let lastAt = 0;

export function startListening() {
    if (sock) return;
    sock = createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", msg => {
        // DiscordHost was closed (Alt+F4 / Steam exit): quit with it
        if (msg.length === 4 && msg.toString() === "QUIT") return quitDiscord();
        if (msg.length < 12) return;
        last = Array.from(msg.subarray(0, 12));
        lastAt = Date.now();
    });
    sock.on("error", () => { sock?.close(); sock = null; });
    sock.bind(HOST_PAD_PORT, "127.0.0.1");
}

export function stopListening() {
    sock?.close();
    sock = null;
    last = null;
}

/** Latest packet bytes, or null if the host hasn't sent one recently. */
export function getPad(): number[] | null {
    return last && Date.now() - lastAt < 300 ? last : null;
}

/** Fully quit Discord (not just hide to tray). Under the host this also ends the Steam session. */
export function quitDiscord() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("electron").app.quit();
}

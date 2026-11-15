/*
 * GamepadNav: keep the message box visible above the Windows touch keyboard.
 *
 * Windows itself is the source of truth: native.ts asks it where the touch
 * keyboard is (IFrameworkInputPane) and we poll that height here, then shrink
 * Discord's root by it so the chat box sits right on top of the keyboard.
 * Chromium's own keyboard signals (VirtualKeyboard API, visual viewport)
 * flip-flopped as soon as the layout changed, so they're only used to stop
 * Chromium scrolling the page by itself.
 */

import type { PluginNative } from "@utils/types";
import { setFlag } from "./flags";

const Native = VencordNative.pluginHelpers.GamepadNav as PluginNative<typeof import("./native")>;

let kbHeight = 0;
let timer: any = null;
let polling = false;

export const isKeyboardUp = () => kbHeight > 0;

function apply(h: number) {
    h = Math.max(0, Math.round(h));
    if (h < 60) h = 0;
    if (h === kbHeight) return;
    kbHeight = h;
    // own <style> rather than html's style attribute, which Discord also rewrites
    let st = document.getElementById("vc-gpn-kb-var");
    if (!st) {
        st = document.createElement("style");
        st.id = "vc-gpn-kb-var";
        document.head.appendChild(st);
    }
    st.textContent = `:root { --gpn-kb: ${h}px; }`;
    setFlag("vc-gpn-kb", h > 0);
    // keep the focused text box in view after the layout changes
    if (h) setTimeout(() => (document.activeElement as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" }), 50);
}

function poll() {
    if (polling || !Native?.getKeyboardHeight) return;
    polling = true;
    Native.getKeyboardHeight().then(px => {
        polling = false;
        // Windows reports physical pixels; CSS wants device-independent ones
        apply(px / (window.devicePixelRatio || 1));
    }, () => { polling = false; });
}

export function startKeyboardWatch() {
    // stop Chromium doing its own (conflicting) scroll-into-view for the keyboard
    try { (navigator as any).virtualKeyboard.overlaysContent = true; } catch { /* unsupported */ }
    timer = setInterval(poll, 120);
}

export function stopKeyboardWatch() {
    clearInterval(timer);
    timer = null;
    try { (navigator as any).virtualKeyboard.overlaysContent = false; } catch { /* unsupported */ }
    apply(0);
}

/*
 * GamepadNav: keep the message box visible above the Windows touch keyboard.
 *
 * Chromium reports the on-screen keyboard through the VirtualKeyboard API
 * (geometrychange) and/or by shrinking the visual viewport. We shrink
 * Discord's root by the keyboard height so the chat box sits right on top.
 *
 * Shrinking the page makes Chromium consider the text box no longer covered,
 * so it reports the keyboard as 0 again (it did this on every keypress).
 * So once a keyboard height is known it's latched while a text box keeps
 * focus, and only released when focus leaves the text box.
 */

let kbHeight = 0;
let cleanup: (() => void) | null = null;

const isTextInput = (el: Element | null) =>
    !!el && el.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]), [contenteditable="true"]');

export const isKeyboardUp = () => kbHeight > 0;

function apply(h: number) {
    h = Math.max(0, Math.round(h));
    if (h === kbHeight) return;
    kbHeight = h;
    document.documentElement.style.setProperty("--gpn-kb", `${h}px`);
    document.body.classList.toggle("vc-gpn-kb", h > 0);
    // keep the focused text box in view after the layout changes
    if (h) setTimeout(() => (document.activeElement as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" }), 50);
}

/** A new height report. Grows/sets freely; "0" is ignored while typing. */
function report(h: number) {
    if (h >= 80) {
        // only ever grow while latched (reports shrink as our own layout changes)
        if (h > kbHeight || !kbHeight) apply(h);
    } else if (!isTextInput(document.activeElement)) {
        apply(0);
    }
}

export function startKeyboardWatch() {
    const vk = (navigator as any).virtualKeyboard;
    const offs: (() => void)[] = [];

    if (vk) {
        try { vk.overlaysContent = true; } catch { /* not allowed here */ }
        const onGeo = () => report(vk.boundingRect?.height ?? 0);
        vk.addEventListener("geometrychange", onGeo);
        offs.push(() => {
            vk.removeEventListener("geometrychange", onGeo);
            try { vk.overlaysContent = false; } catch { /* ignore */ }
        });
    }

    const vv = window.visualViewport;
    if (vv) {
        const onVv = () => report(window.innerHeight - vv.height);
        vv.addEventListener("resize", onVv);
        offs.push(() => vv.removeEventListener("resize", onVv));
    }

    // release when the text box loses focus (keyboard is done)
    const onFocusOut = () => setTimeout(() => {
        if (!isTextInput(document.activeElement)) apply(0);
    }, 150);
    document.addEventListener("focusout", onFocusOut, true);
    offs.push(() => document.removeEventListener("focusout", onFocusOut, true));

    cleanup = () => {
        offs.forEach(f => f());
        apply(0);
    };
}

export function stopKeyboardWatch() {
    cleanup?.();
    cleanup = null;
}

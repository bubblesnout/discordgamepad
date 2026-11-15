/*
 * GamepadNav: keep the message box visible above the Windows touch keyboard.
 *
 * Chromium reports the on-screen keyboard through the VirtualKeyboard API
 * (geometrychange). We ask it to overlay the page instead of doing its own
 * thing, then shrink Discord's root by the keyboard height so the chat box
 * and newest messages sit right on top of it. visualViewport resizes are
 * used as a fallback signal.
 */

let kbHeight = 0;
let cleanup: (() => void) | null = null;

function apply(h: number) {
    h = Math.max(0, Math.round(h));
    if (h < 80) h = 0; // ignore tiny changes (suggestion bars, rounding)
    if (h === kbHeight) return;
    kbHeight = h;
    document.documentElement.style.setProperty("--gpn-kb", `${h}px`);
    document.body.classList.toggle("vc-gpn-kb", h > 0);
    // keep the focused text box in view after the layout changes
    if (h) setTimeout(() => (document.activeElement as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" }), 50);
}

export function startKeyboardWatch() {
    const vk = (navigator as any).virtualKeyboard;
    const offs: (() => void)[] = [];

    if (vk) {
        try { vk.overlaysContent = true; } catch { /* not allowed here */ }
        const onGeo = () => apply(vk.boundingRect?.height ?? 0);
        vk.addEventListener("geometrychange", onGeo);
        offs.push(() => {
            vk.removeEventListener("geometrychange", onGeo);
            try { vk.overlaysContent = false; } catch { /* ignore */ }
        });
    }

    const vv = window.visualViewport;
    if (vv) {
        const onVv = () => {
            if ((navigator as any).virtualKeyboard?.boundingRect?.height) return; // API already handled it
            apply(window.innerHeight - vv.height);
        };
        vv.addEventListener("resize", onVv);
        offs.push(() => vv.removeEventListener("resize", onVv));
    }

    cleanup = () => {
        offs.forEach(f => f());
        apply(0);
    };
}

export function stopKeyboardWatch() {
    cleanup?.();
    cleanup = null;
}

/*
 * GamepadNav: focus ring and spatial navigation over Discord's own UI.
 * The ring is a separate overlay that follows the target's rect, so it never
 * depends on Discord's class names or :focus styles.
 */

export type Dir = "up" | "down" | "left" | "right";

const CANDIDATES = [
    "button:not([disabled])",
    "a[href]",
    "input:not([type=hidden]):not([disabled])",
    "textarea",
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="treeitem"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="slider"]',
    "[data-list-item-id]",
].join(",");

const HOVER_TOOLBARS = [
    '[role="group"][aria-label*="Message Actions" i]',
    '[class*="hoverBarButton"]',
    '[class*="buttonContainer_"] [class*="buttons_"]',
].join(",");

let current: HTMLElement | null = null;
let ring: HTMLDivElement | null = null;
let hidden = false;

export function mountRing() {
    ring = document.createElement("div");
    ring.className = "vc-gpn-ring";
    document.body.appendChild(ring);
}

export function unmountRing() {
    ring?.remove();
    ring = null;
    current = null;
}

export function setRingHidden(h: boolean) {
    hidden = h;
}

export const getCurrent = () => (current?.isConnected ? current : null);

/** Called every frame so the ring tracks scrolling, animations and re-renders. */
export function updateRing() {
    if (!ring) return;
    if (current && !current.isConnected) current = recoverFromDetach();
    if (!current || hidden) {
        ring.style.opacity = "0";
        return;
    }
    const r = current.getBoundingClientRect();
    ring.style.opacity = "1";
    ring.style.transform = `translate(${r.left - 4}px, ${r.top - 4}px)`;
    ring.style.width = `${r.width + 8}px`;
    ring.style.height = `${r.height + 8}px`;
}

// Discord re-renders list items often. Re-find the element by the same list id.
let lastListId: string | null = null;
function recoverFromDetach(): HTMLElement | null {
    if (!lastListId) return null;
    return document.querySelector<HTMLElement>(`[data-list-item-id="${CSS.escape(lastListId)}"]`);
}

export function focusEl(el: HTMLElement | null, scroll = true) {
    if (!el) return;
    current = el;
    lastListId = el.closest("[data-list-item-id]")?.getAttribute("data-list-item-id") ?? null;
    if (scroll) el.scrollIntoView({ block: "nearest", inline: "nearest" });
    // keyboard focus too, so Discord's roving tabindex and aria state follow us
    try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
}

/** The topmost layer that should capture navigation: menu, popout, modal, or the app. */
export function activeRoot(): ParentNode {
    const menus = document.querySelectorAll('[role="menu"]');
    if (menus.length) return menus[menus.length - 1];
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"]')]
        .filter(d => d.getBoundingClientRect().width > 0 && !d.closest(".vc-gpn-panel"));
    if (dialogs.length) return dialogs[dialogs.length - 1];
    return document.getElementById("app-mount") ?? document.body;
}

function isVisible(el: HTMLElement, r: DOMRect) {
    if (r.width < 4 || r.height < 4) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const hit = document.elementFromPoint(cx, cy);
    if (!hit) return false;
    if (hit.classList.contains("vc-gpn-ring")) return true;
    return el === hit || el.contains(hit) || hit.contains(el);
}

export function candidates(root: ParentNode = activeRoot()) {
    const els = [...root.querySelectorAll<HTMLElement>(CANDIDATES)];
    const out: { el: HTMLElement; r: DOMRect; }[] = [];
    for (const el of els) {
        if (el.closest(".vc-gpn-panel, [aria-hidden='true']")) continue;
        // The hover toolbar on a message (quick reactions, reply, edit...) pops up
        // when a message gets focus and sits right where "down" lands. Skip it;
        // X (context menu) has all the same actions.
        if (el.closest(HOVER_TOOLBARS)) continue;
        const r = el.getBoundingClientRect();
        if (!isVisible(el, r)) continue;
        out.push({ el, r });
    }
    // Drop a wrapper when one candidate inside it covers most of it (e.g. channel
    // <li> wrapping its <a>). Keep the inner one, since that's what Discord's click handler is on.
    return out.filter(o => !out.some(inner =>
        inner !== o && o.el.contains(inner.el)
        && inner.r.width * inner.r.height >= 0.6 * o.r.width * o.r.height));
}

/** Pick the best candidate in a direction from the current element. */
export function move(dir: Dir): boolean {
    const root = activeRoot();
    const list = candidates(root);
    const cur = getCurrent();
    if (!cur || !(root as Node).contains(cur) || !list.length) {
        focusEl(list[0]?.el ?? null);
        return !!list.length;
    }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;

    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const { el, r } of list) {
        if (el === cur || el.contains(cur) || cur.contains(el)) continue;
        const bx = r.left + r.width / 2, by = r.top + r.height / 2;
        let main: number, cross: number;
        switch (dir) {
            case "up": main = a.top - r.bottom; cross = bx - ax; if (by >= ay) continue; break;
            case "down": main = r.top - a.bottom; cross = bx - ax; if (by <= ay) continue; break;
            case "left": main = a.left - r.right; cross = by - ay; if (bx >= ax) continue; break;
            case "right": main = r.left - a.right; cross = by - ay; if (bx <= ax) continue; break;
        }
        // overlapping on the main axis counts as distance 0
        main = Math.max(main, 0);
        // stay in the same column/row when possible: cross-axis offset costs more
        const overlap = dir === "up" || dir === "down"
            ? Math.min(a.right, r.right) - Math.max(a.left, r.left)
            : Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top);
        const crossCost = overlap > 0 ? 0 : Math.abs(cross) * 2;
        const score = main + crossCost;
        if (score < bestScore) {
            bestScore = score;
            best = el;
        }
    }
    if (best) {
        focusEl(best);
        return true;
    }
    // Nothing visible that way: scroll the list we're in and let the caller retry.
    const sc = scrollableAncestor(cur, dir === "up" || dir === "down" ? "y" : "x");
    if (sc) {
        const amount = (dir === "up" || dir === "left" ? -1 : 1) * 0.6 * (dir === "up" || dir === "down" ? sc.clientHeight : sc.clientWidth);
        sc.scrollBy(dir === "up" || dir === "down" ? { top: amount } : { left: amount });
    }
    return false;
}

export function scrollableAncestor(el: Element | null, axis: "x" | "y" = "y"): HTMLElement | null {
    for (let n = el as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
        const s = getComputedStyle(n);
        const ov = axis === "y" ? s.overflowY : s.overflowX;
        if ((ov === "auto" || ov === "scroll") &&
            (axis === "y" ? n.scrollHeight > n.clientHeight + 2 : n.scrollWidth > n.clientWidth + 2))
            return n;
    }
    return null;
}

export const isTextInput = (el: Element | null) =>
    !!el && (el.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]), [contenteditable="true"]')
        || !!el.querySelector?.('[contenteditable="true"]'));

export const isSlider = (el: Element | null) => !!el && el.matches('[role="slider"], input[type=range]');

function center(el: HTMLElement) {
    const r = el.getBoundingClientRect();
    return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
}

/** Fire the same event sequence a real mouse click produces. */
export function activate(el: HTMLElement) {
    const c = center(el);
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, ...c };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
}

export function contextMenu(el: HTMLElement) {
    const c = center(el);
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, view: window, button: 2, ...c }));
}

export function key(k: string, target: EventTarget = document.activeElement ?? document.body, extra: KeyboardEventInit = {}) {
    const codes: Record<string, number> = { Escape: 27, Enter: 13, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PageUp: 33, PageDown: 34 };
    const init: any = { key: k, code: k, keyCode: codes[k], which: codes[k], bubbles: true, cancelable: true, composed: true, ...extra };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
}

/** Focus the first candidate inside the first element matching any selector. */
export function focusFirstIn(...selectors: string[]): boolean {
    for (const sel of selectors) {
        const root = document.querySelector(sel);
        if (!root) continue;
        const preferred = root.querySelector<HTMLElement>('[aria-selected="true"], [aria-current="page"], [class*="selected"]');
        const list = candidates(root);
        const pick = (preferred && list.find(c => c.el === preferred || c.el.contains(preferred) || preferred.contains(c.el))) ?? list[0];
        if (pick) {
            focusEl(pick.el);
            return true;
        }
    }
    return false;
}

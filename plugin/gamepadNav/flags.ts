/*
 * GamepadNav: sticky classes on <body>.
 *
 * Discord rewrites body's class list at times (e.g. as you type), which wiped
 * our markers: the keyboard shift dropped on every keypress. Flags set here are
 * remembered and put back by a MutationObserver whenever they go missing.
 */

const wanted = new Set<string>();
let observer: MutationObserver | null = null;

function reapply() {
    for (const c of wanted) if (!document.body.classList.contains(c)) document.body.classList.add(c);
}

export function setFlag(name: string, on: boolean) {
    if (on) wanted.add(name);
    else wanted.delete(name);
    document.body.classList.toggle(name, on);
    if (!observer) {
        observer = new MutationObserver(reapply);
        observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    }
}

export function clearFlags() {
    observer?.disconnect();
    observer = null;
    for (const c of wanted) document.body.classList.remove(c);
    wanted.clear();
}

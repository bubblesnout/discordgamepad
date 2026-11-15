/*
 * GamepadNav: font switcher.
 *
 * Offers readable 10-foot fonts that are actually available: Windows fonts
 * that are installed, plus any fonts in the repo's git-ignored fonts/ folder
 * (e.g. Motiva Sans), which are loaded from disk via native.ts. A font that
 * isn't present never shows up in the list.
 */

import type { PluginNative } from "@utils/types";

const Native = VencordNative.pluginHelpers.GamepadNav as PluginNative<typeof import("./native")>;

export interface FontChoice { id: string; label: string; stack: string | null; }

// Windows fonts that read well from a distance, in order of preference.
const SYSTEM: FontChoice[] = [
    { id: "segoe-variable", label: "Segoe UI Variable", stack: '"Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI"' },
    { id: "segoe", label: "Segoe UI", stack: '"Segoe UI"' },
    { id: "bahnschrift", label: "Bahnschrift", stack: "Bahnschrift" },
    { id: "verdana", label: "Verdana", stack: "Verdana" },
    { id: "tahoma", label: "Tahoma", stack: "Tahoma" },
];

const DEFAULT: FontChoice = { id: "default", label: "Discord default (gg sans)", stack: null };

let localFamilies: string[] = [];
let loaded = false;

/** Load fonts from the fonts/ folder into the page (once). */
export async function loadLocalFonts() {
    if (loaded) return;
    loaded = true;
    try {
        const files = await Native?.listLocalFonts?.() ?? [];
        for (const f of files) {
            const face = new FontFace(f.family, f.data as any, { weight: String(f.weight) });
            await face.load();
            document.fonts.add(face);
            if (!localFamilies.includes(f.family)) localFamilies.push(f.family);
        }
    } catch {
        // a broken font file just means that font isn't offered
    }
}

/** True if the browser has this font installed (it renders differently from the fallbacks). */
function installed(family: string) {
    const c = document.createElement("canvas").getContext("2d");
    if (!c) return false;
    const text = "mmmmmmmmmmlli1WQ@#";
    return ["monospace", "serif"].some(fb => {
        c.font = `32px ${fb}`;
        const base = c.measureText(text).width;
        c.font = `32px "${family}", ${fb}`;
        return c.measureText(text).width !== base;
    });
}

export function availableFonts(): FontChoice[] {
    const local = localFamilies.map(f => ({ id: `local:${f}`, label: f, stack: `"${f}"` }));
    const sys = SYSTEM.filter(f => installed(f.stack!.split(",")[0].replace(/"/g, "").trim()));
    return [DEFAULT, ...local, ...sys];
}

export function fontLabel(id: string) {
    return availableFonts().find(f => f.id === id)?.label ?? DEFAULT.label;
}

/** Apply a font everywhere: Discord itself (via its font variables) and the menu. */
export function applyFont(id: string) {
    const f = availableFonts().find(x => x.id === id);
    let st = document.getElementById("vc-gpn-font");
    if (!f?.stack) {
        st?.remove();
        return;
    }
    if (!st) {
        st = document.createElement("style");
        st.id = "vc-gpn-font";
        document.head.appendChild(st);
    }
    const stack = `${f.stack}, "gg sans", sans-serif`;
    st.textContent = `:root, .theme-dark, .theme-light, .visual-refresh {
    --font-primary: ${stack} !important;
    --font-display: ${stack} !important;
    --font-headline: ${stack} !important;
}
.vc-gpn-shell, .vc-gpn-toast, .vc-gpn-help { font-family: ${stack} !important; }`;
}

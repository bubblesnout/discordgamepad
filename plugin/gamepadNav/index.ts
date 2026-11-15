/*
 * GamepadNav: drive Discord with an XInput controller (built for the ROG Xbox Ally X
 * launched from Steam Big Picture). Reads the pad with navigator.getGamepads(),
 * no Steam Input mouse emulation needed.
 *
 *   D-pad / left stick  move the focus ring          A  select
 *   B                   back / close                 X  context menu (right click)
 *   Y                   call (in a DM) or mute       Start  type in chat / send
 *   LB / RB             Home · Friends · Servers · Voice tabs     View  controls help
 *   Right stick         scroll                       LT / RT  page up / down
 */

import { definePluginSettings } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import definePlugin, { OptionType, PluginNative } from "@utils/types";

import * as A from "./actions";
import couchStyle from "./couch.css?managed";
import { isKeyboardUp, setOnKeyboardClosed, startKeyboardWatch, stopKeyboardWatch } from "./keyboard";
import * as N from "./nav";
import * as S from "./shell";
import style from "./style.css?managed";
import { clearFlags, setFlag } from "./flags";

const settings = definePluginSettings({
    tenFoot: {
        type: OptionType.BOOLEAN,
        description: "10-foot mode: full-screen chat with no sidebars (use the menu with B / LB / RB instead)",
        default: true,
        onChange: (v: boolean) => setFlag("vc-gpn-10ft", v),
    },
    fullscreen: {
        type: OptionType.BOOLEAN,
        description: "True fullscreen (like F11) when Discord starts, above the handheld taskbar",
        default: true,
        onChange: (v: boolean) => { Native?.setFullscreen?.(v); },
    },
    openOnStart: {
        type: OptionType.BOOLEAN,
        description: "Open the Home screen when Discord starts",
        default: true,
    },
    couchTheme: {
        type: OptionType.BOOLEAN,
        description: "Couch theme: bigger text and targets, less clutter",
        default: true,
        onChange: (v: boolean) => v ? enableStyle(couchStyle) : disableStyle(couchStyle),
    },
    autoConfirmGoLive: {
        type: OptionType.BOOLEAN,
        description: "Press Go Live in Discord's stream dialog automatically",
        default: true,
        onChange: (v: boolean) => { S.settingsRef.autoConfirmGoLive = v; },
    },
    volumeStep: {
        type: OptionType.SLIDER,
        description: "Volume change per D-pad press (%)",
        markers: [5, 10, 20],
        default: 10,
        stickToMarkers: true,
        onChange: (v: number) => { S.settingsRef.volumeStep = v; },
    },
    stickDeadzone: {
        type: OptionType.SLIDER,
        description: "Stick deadzone",
        markers: [0.2, 0.3, 0.4, 0.5, 0.6],
        default: 0.5,
        stickToMarkers: false,
    },
});

// Standard Gamepad mapping (XInput pads in Chromium)
const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;
type Btn = keyof typeof B | "LS_UP" | "LS_DOWN" | "LS_LEFT" | "LS_RIGHT";

const REPEAT_DELAY = 350;
const REPEAT_RATE = 90;
const REPEATS = new Set<Btn>(["UP", "DOWN", "LEFT", "RIGHT", "LS_UP", "LS_DOWN", "LS_LEFT", "LS_RIGHT"]);

let timer: any;
let held: Partial<Record<Btn, number>> = {}; // button -> next repeat time
let typing = false;
let helpEl: HTMLDivElement | null = null;
let lastPadUse = 0;
let tickCount = 0;
let classic = false; // temporarily showing Discord's full UI

/** Full Discord UI (sidebars back, menu closed), still driven by the focus ring. */
function setClassic(on: boolean) {
    classic = on;
    setFlag("vc-gpn-10ft", settings.store.tenFoot && !on);
    if (on) {
        S.hide();
        S.toast("Full Discord · R3 or LB / RB to go back");
        setTimeout(() => N.focusFirstIn('[data-list-id="guildsnav"]') || N.move("down"), 300);
    } else {
        S.toast("10-foot mode");
    }
}

// Electron main-process helpers (see native.ts): quit, fullscreen
const Native = VencordNative.pluginHelpers.GamepadNav as PluginNative<typeof import("./native")>;

function readPad(): Gamepad | null {
    let best: Gamepad | null = null;
    for (const p of navigator.getGamepads?.() ?? []) {
        if (p?.connected && (!best || p.timestamp > best.timestamp)) best = p;
    }
    return best;
}

function pressedSet(p: Gamepad) {
    const dz = settings.store.stickDeadzone;
    const s = new Set<Btn>();
    for (const [name, i] of Object.entries(B)) {
        const b = p.buttons[i];
        if (b && (b.pressed || b.value > 0.5)) s.add(name as Btn);
    }
    const [lx = 0, ly = 0] = p.axes;
    // only the dominant axis, so diagonals don't double-move
    if (Math.abs(lx) > dz || Math.abs(ly) > dz) {
        if (Math.abs(lx) > Math.abs(ly)) s.add(lx < 0 ? "LS_LEFT" : "LS_RIGHT");
        else s.add(ly < 0 ? "LS_UP" : "LS_DOWN");
    }
    return s;
}

function tick() {
    N.updateRing();
    if (++tickCount % 30 === 0) S.updateDock();
    const pad = readPad();
    if (!pad) return;

    const now = performance.now();
    const down = pressedSet(pad);

    for (const b of Object.keys(held) as Btn[]) if (!down.has(b)) delete held[b];
    for (const b of down) {
        if (held[b] == null) {
            held[b] = now + REPEAT_DELAY;
            onPress(b);
        } else if (REPEATS.has(b) && now >= held[b]!) {
            held[b] = now + REPEAT_RATE;
            onPress(b);
        }
    }

    // right stick: smooth scroll whatever is under the ring (or the chat)
    const ry = pad.axes[3] ?? 0;
    if (Math.abs(ry) > 0.2) {
        (S.isOpen() ? document.querySelector(".vc-gpn-scroll") : scrollTarget())?.scrollBy({ top: ry * 28 });
        markPadUse();
    }
}

function markPadUse() {
    lastPadUse = performance.now();
    N.setRingHidden(false);
}

function scrollTarget(): HTMLElement | null {
    const cur = N.getCurrent();
    return N.scrollableAncestor(cur)
        ?? N.scrollableAncestor(document.querySelector('[data-list-id="chat-messages"]'))
        ?? null;
}

const dirOf = (b: Btn): N.Dir | null =>
    b === "UP" || b === "LS_UP" ? "up"
        : b === "DOWN" || b === "LS_DOWN" ? "down"
            : b === "LEFT" || b === "LS_LEFT" ? "left"
                : b === "RIGHT" || b === "LS_RIGHT" ? "right" : null;

function onPress(b: Btn) {
    markPadUse();
    const dir = dirOf(b);

    if (b === "VIEW") return toggleHelp();
    if (b === "R3") return setClassic(!classic);
    if (helpEl && b === "B") return toggleHelp();

    if (b === "LB" || b === "RB") {
        typing = false;
        if (classic) setClassic(false);
        if (S.isOpen()) S.cycleTab(b === "RB" ? 1 : -1);
        else S.show();
        return;
    }

    // ---- 10-foot shell ----
    if (S.isOpen()) {
        if (b === "B") {
            if (S.back()) return; // closes a dialog or leaves a server
            if (S.backToHome()) return; // other tabs: B goes Home first
            if (S.backAtHome(quitDiscord)) return;
            leaveShell();
            return;
        }
        if (dir) return S.handle(dir);
        if (b === "A") return S.handle("a");
        if (b === "X") return S.handle("x");
        if (b === "Y") return S.handle("y");
        return;
    }

    // ---- typing in a text box (Steam keyboard does the letters) ----
    if (typing && !N.isTextInput(document.activeElement)) typing = false; // clicked away
    if (typing) {
        const box = document.activeElement as HTMLElement | null;
        if (b === "START" && box) return N.key("Enter", box);
        if (b === "B") {
            typing = false;
            if (isKeyboardUp()) Native?.toggleTouchKeyboard?.(); // put the keyboard away too
            box?.blur();
            N.setRingHidden(false);
            return;
        }
        return;
    }

    if (dir) {
        const cur = N.getCurrent();
        if ((dir === "left" || dir === "right") && N.isSlider(cur)) {
            N.key(dir === "left" ? "ArrowLeft" : "ArrowRight", cur!);
            return;
        }
        if (!N.move(dir)) setTimeout(() => N.move(dir), 150); // list scrolled; try again
        return;
    }

    switch (b) {
        case "A": return select();
        case "B": return back();
        case "X": {
            const cur = N.getCurrent();
            if (cur) N.contextMenu(cur);
            setTimeout(() => N.move("down"), 120); // land inside the menu
            return;
        }
        case "Y": return quickAction();
        case "START": return startTyping();
        case "LT":
        case "RT": {
            const sc = scrollTarget();
            sc?.scrollBy({ top: (b === "RT" ? 1 : -1) * sc.clientHeight * 0.85 });
            return;
        }
    }
}

function select() {
    const cur = N.getCurrent();
    if (!cur) return void N.move("down");
    if (N.isTextInput(cur)) return startTyping(cur);
    N.activate(cur);
}

function startTyping(el?: HTMLElement) {
    const box = (el?.matches('[contenteditable="true"], textarea, input') ? el : el?.querySelector<HTMLElement>('[contenteditable="true"]'))
        ?? document.querySelector<HTMLElement>('main [role="textbox"][contenteditable="true"], [role="textbox"][contenteditable="true"]');
    if (!box) return S.toast("No text box here");
    N.focusEl(box);
    box.focus();
    typing = true;
    // bring up the Windows touch keyboard (focus alone only does that for a tap)
    setTimeout(() => { if (!isKeyboardUp()) Native?.toggleTouchKeyboard?.(); }, 120);
    S.toast("Typing · Start sends · B done");
}

function quitDiscord() {
    if (Native?.quitDiscord) Native.quitDiscord();
    else window.close();
}

function leaveShell() {
    S.hide();
    focusChat();
}

function focusChat() {
    setTimeout(() => {
        const box = document.querySelector<HTMLElement>('main [role="textbox"], [role="textbox"][contenteditable="true"]');
        if (box) N.focusEl(box.closest("form") as HTMLElement ?? box);
        else N.move("down");
    }, 400);
}

function back() {
    if (N.activeRoot() !== (document.getElementById("app-mount") ?? document.body)) {
        N.key("Escape");
        setTimeout(() => N.move("down"), 150);
        return;
    }
    if (settings.store.tenFoot && !classic) {
        const gid = A.currentTextChannel()?.guild_id;
        if (gid) S.show("servers", gid);
        else S.show("home");
        return;
    }
    const cur = N.getCurrent();
    const guilds = document.querySelector('[data-list-id="guildsnav"]');
    const channels = document.querySelector('#channels, [data-list-id="channels"], nav[aria-label="Private channels"], [aria-label="Private channels"]');
    if (cur && guilds?.contains(cur)) return;
    if (cur && channels?.contains(cur)) {
        N.focusFirstIn('[data-list-id="guildsnav"]');
        return;
    }
    if (!N.focusFirstIn('#channels', '[data-list-id="channels"]', 'nav[aria-label="Private channels"]'))
        N.focusFirstIn('[data-list-id="guildsnav"]');
}

async function quickAction() {
    const ch = A.currentTextChannel();
    if (ch && A.isPrivateChannel(ch) && A.currentVoiceChannelId() !== ch.id) {
        S.toast("Calling…");
        await A.callDM(ch.id);
        return;
    }
    if (A.currentVoiceChannelId()) {
        A.toggleSelfMute();
        setTimeout(() => S.toast(A.isSelfMute() ? "Muted" : "Unmuted"), 80);
    }
}

function toggleHelp() {
    if (helpEl) {
        helpEl.remove();
        helpEl = null;
        return;
    }
    helpEl = document.createElement("div");
    helpEl.className = "vc-gpn-help";
    helpEl.innerHTML = `<h2>Controller</h2><table>
<tr><td>D-pad / L stick</td><td>Move</td></tr>
<tr><td>A</td><td>Select</td></tr>
<tr><td>B</td><td>Back / close</td></tr>
<tr><td>X</td><td>Context menu</td></tr>
<tr><td>Y</td><td>Call (in a DM) · Mute (in voice)</td></tr>
<tr><td>LB / RB</td><td>Menu: Home · Friends · Servers · Voice</td></tr>
<tr><td>B (in chat)</td><td>Back to the menu</td></tr>
<tr><td>Start</td><td>Type in chat · Send</td></tr>
<tr><td>R stick · LT / RT</td><td>Scroll · Page up / down</td></tr>
<tr><td>R3 (click right stick)</td><td>Full Discord UI and back</td></tr>
<tr><td>View</td><td>This help</td></tr></table>
<p>Voice panel: ◀ ▶ volume · A mute for me · X reset to 100%</p>`;
    document.body.appendChild(helpEl);
}

// Hide the ring while someone uses the mouse or touchscreen.
function onMouse() {
    if (performance.now() - lastPadUse > 500) N.setRingHidden(true);
}

function onConnect(e: GamepadEvent) {
    S.toast(`Controller connected · View for help`);
    A.log.info("gamepad", e.gamepad.id, e.gamepad.mapping);
}

export default definePlugin({
    name: "GamepadNav",
    description: "Use Discord with an Xbox-style controller: focus ring navigation, voice volume, friends, calls and Go Live.",
    authors: [{ name: "bubblesnout", id: 0n }],
    settings,
    managedStyle: style,

    flux: {
        // remember voice channels as you join them, for Home's "Recent voice channels"
        VOICE_CHANNEL_SELECT({ channelId }: { channelId: string | null; }) {
            A.recordVoiceJoin(channelId);
        },
    },

    start() {
        if (settings.store.fullscreen) Native?.setFullscreen?.(true);
        // The Windows keyboard takes the controller while it's open, so its own B
        // closes it without us seeing the press: leave typing mode when it goes.
        setOnKeyboardClosed(() => {
            if (!typing) return;
            typing = false;
            N.setRingHidden(false);
        });
        startKeyboardWatch();
        Native?.warmTouchKeyboard?.();
        A.loadRecentVoice().then(() => A.recordVoiceJoin(A.currentVoiceChannelId()));
        S.settingsRef.autoConfirmGoLive = settings.store.autoConfirmGoLive;
        S.settingsRef.volumeStep = settings.store.volumeStep;
        S.setOnEnterChat(focusChat);
        S.setOnClassic(() => setClassic(true));
        S.setOnQuit(quitDiscord);
        setFlag("vc-gpn-10ft", settings.store.tenFoot);
        // open straight away (no delay), so Discord's own Friends page never flashes up
        if (settings.store.openOnStart) S.show("home");
        if (settings.store.couchTheme) enableStyle(couchStyle);
        N.mountRing();
        window.addEventListener("gamepadconnected", onConnect);
        window.addEventListener("mousemove", onMouse, { passive: true });
        window.addEventListener("pointerdown", onMouse, { passive: true });
        // setInterval instead of rAF: rAF stops when Discord is behind Big Picture
        timer = setInterval(tick, 16);
    },

    stop() {
        stopKeyboardWatch();
        Native?.stopTouchKeyboard?.();
        clearInterval(timer);
        window.removeEventListener("gamepadconnected", onConnect);
        window.removeEventListener("mousemove", onMouse);
        window.removeEventListener("pointerdown", onMouse);
        disableStyle(couchStyle);
        N.unmountRing();
        S.destroy();
        clearFlags();
        helpEl?.remove();
        helpEl = null;
        held = {};
        typing = false;
    },
});

/*
 * GamepadNav: the 10-foot shell. A full-screen, console-style launcher with
 * tabs (Home · Friends · Servers · Voice) drawn by the plugin from Discord's
 * stores. Discord's own UI is only used for the chat view behind it.
 */

import {
    ChannelStore,
    GuildChannelStore,
    GuildStore,
    IconUtils,
    NavigationRouter,
    ReadStateStore,
    SettingsRouter,
    SortedGuildStore,
    UserStore,
} from "@webpack/common";

import * as A from "./actions";
import type { Dir } from "./nav";

export type Tab = "home" | "friends" | "servers" | "voice";
export const TABS: Tab[] = ["home", "friends", "servers", "voice"];
const TAB_NAMES: Record<Tab, string> = { home: "Home", friends: "Friends", servers: "Servers", voice: "Voice" };

interface Item {
    id: string;
    label: string;
    sub?: string;
    img?: string;
    initials?: string;
    badge?: string;
    tone?: "live" | "ok" | "danger" | "accent";
    meter?: number; // 0-200
    onA?(): any;
    onX?(): any;
    onY?(): any;
    yLabel?: string; // footer hint for Y (default "Call")
    onLeft?(): any;
    onRight?(): any;
}
interface Section {
    title: string;
    layout: "shelf" | "tiles" | "small" | "list";
    items: Item[];
    empty?: string;
}

export const settingsRef = { autoConfirmGoLive: true, volumeStep: 10 };

let root: HTMLDivElement | null = null;
let header: HTMLDivElement;
let footer: HTMLDivElement;
let scroller: HTMLDivElement;
let content: HTMLDivElement;
let dock: HTMLDivElement | null = null;
let open = false;
let tab: Tab = "home";
let drillGuild: string | null = null;
let items: Item[] = [];
const selected: Record<string, string> = {};
let lastHtml = "";
let lastScrolledTo = "";
let lastView = "";
let timer: any;
let toastTimer: any;

const viewKey = () => tab + (tab === "servers" && drillGuild ? ":" + drillGuild : "");

export const isOpen = () => open;
export const currentTab = () => tab;

/* ---------- lifecycle ---------- */

function mount() {
    if (root) return;
    root = document.createElement("div");
    root.className = "vc-gpn-shell";
    header = document.createElement("div");
    header.className = "vc-gpn-tabs";
    scroller = document.createElement("div");
    scroller.className = "vc-gpn-scroll";
    content = document.createElement("div");
    scroller.appendChild(content);
    footer = document.createElement("div");
    footer.className = "vc-gpn-footer";
    root.append(header, scroller, footer);
    root.addEventListener("click", onTap);
    document.body.appendChild(root);
}

export function show(t: Tab = tab, guildId: string | null = null) {
    mount();
    if (t !== tab || guildId) drillGuild = guildId;
    tab = t;
    open = true;
    root!.style.display = "";
    document.body.classList.add("vc-gpn-shell-open");
    lastHtml = "";
    render();
    clearInterval(timer);
    timer = setInterval(render, 1000);
}

export function hide() {
    open = false;
    clearInterval(timer);
    if (root) root.style.display = "none";
    document.body.classList.remove("vc-gpn-shell-open");
}

export function destroy() {
    hide();
    root?.remove();
    dock?.remove();
    document.querySelector(".vc-gpn-toast")?.remove();
    root = dock = null;
}

export function cycleTab(delta: number) {
    const i = TABS.indexOf(tab);
    show(TABS[(i + delta + TABS.length) % TABS.length]);
}

/** B inside the shell. Returns false when there's nothing left to go back from. */
export function back(): boolean {
    if (confirm) { closeConfirm(); return true; }
    if (tab === "servers" && drillGuild) {
        drillGuild = null;
        render();
        return true;
    }
    return false;
}

export function toast(text: string) {
    let t = document.querySelector<HTMLDivElement>(".vc-gpn-toast");
    if (!t) {
        t = document.createElement("div");
        t.className = "vc-gpn-toast";
        document.body.appendChild(t);
    }
    t.textContent = text;
    t.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t!.style.opacity = "0", 2200);
}

/* ---------- confirm dialog (Big Picture style) ---------- */

let confirm: { title: string; body: string; sel: 0 | 1; onYes(): void; } | null = null;
let confirmEl: HTMLDivElement | null = null;

export const isConfirmOpen = () => !!confirm;

export function askConfirm(title: string, body: string, onYes: () => void) {
    confirm = { title, body, sel: 0, onYes };
    drawConfirm();
}

function closeConfirm() {
    confirm = null;
    confirmEl?.remove();
    confirmEl = null;
}

function drawConfirm() {
    if (!root || !confirm) return;
    if (!confirmEl) {
        confirmEl = document.createElement("div");
        confirmEl.className = "vc-gpn-confirm";
        confirmEl.addEventListener("click", e => {
            const b = (e.target as HTMLElement).closest<HTMLElement>("[data-choice]");
            if (!b || !confirm) return;
            confirm.sel = b.dataset.choice === "yes" ? 0 : 1;
            confirmHandle("a");
        });
        root.appendChild(confirmEl);
    }
    confirmEl.innerHTML = `<div class="vc-gpn-confirm-box"><h2>${esc(confirm.title)}</h2><p>${esc(confirm.body)}</p>`
        + `<div class="vc-gpn-confirm-btns"><span data-choice="yes" class="${confirm.sel === 0 ? "on" : ""}">Yes</span>`
        + `<span data-choice="no" class="${confirm.sel === 1 ? "on" : ""}">No</span></div></div>`;
}

function confirmHandle(btn: Dir | "a" | "x" | "y") {
    if (!confirm) return;
    if (btn === "left" || btn === "right" || btn === "up" || btn === "down") {
        confirm.sel = confirm.sel ? 0 : 1;
        drawConfirm();
    } else if (btn === "a") {
        const yes = confirm.sel === 0 ? confirm.onYes : null;
        closeConfirm();
        yes?.();
    }
}

/** B on the top level of a tab other than Home: go to Home. */
export function backToHome(): boolean {
    if (tab === "home" || confirm) return false;
    show("home");
    return true;
}

/** B on the top level of Home: offer to quit. Returns true if handled. */
export function backAtHome(onQuit: () => void): boolean {
    if (tab !== "home" || confirm) return false;
    askConfirm("Quit Discord?", "This closes Discord completely.", onQuit);
    return true;
}

/* ---------- data helpers ---------- */

const userAvatar = (u: any) => { try { return IconUtils.getUserAvatarURL(u, false, 128); } catch { return undefined; } };
const guildIcon = (g: any) => { try { return g.icon ? IconUtils.getGuildIconURL({ id: g.id, icon: g.icon, size: 128 }) : undefined; } catch { return undefined; } };
// First letter of up to 3 words. Skips emoji/symbols ("🔊 General" -> "G"):
// w[0] on an emoji is half a surrogate pair and renders as "?".
const initials = (s: string) =>
    s.split(/\s+/).map(w => w.match(/[\p{L}\p{N}]/u)?.[0] ?? "").join("").slice(0, 3).toUpperCase() || "?";
const names = (ms: { user: any; }[], max = 3) =>
    ms.slice(0, max).map(m => A.displayName(m.user)).join(", ") + (ms.length > max ? ` +${ms.length - max}` : "");

export function openChannel(guildId: string | null, channelId: string) {
    NavigationRouter.transitionTo(`/channels/${guildId ?? "@me"}/${channelId}`);
    hide();
    onEnterChat?.();
}
export let onEnterChat: (() => void) | null = null;
export const setOnEnterChat = (fn: () => void) => { onEnterChat = fn; };
let onClassic: (() => void) | null = null;
let quitFn: (() => void) | null = null;
export const setOnQuit = (fn: () => void) => { quitFn = fn; };
export const setOnClassic = (fn: () => void) => { onClassic = fn; };

function joinAndShowVoice(channelId: string) {
    A.joinVoice(channelId);
    tab = "voice";
    drillGuild = null;
    setTimeout(render, 300);
}

function privateChannelItem(c: any): Item {
    const isDM = c.type === 1;
    const other = isDM ? UserStore.getUser(c.recipients?.[0]) : null;
    const label = isDM ? A.displayName(other) : (c.name || c.recipients?.map((id: string) => A.displayName(UserStore.getUser(id))).slice(0, 3).join(", ") || "Group");
    const mentions = ReadStateStore.getMentionCount(c.id);
    const unread = ReadStateStore.hasUnread(c.id);
    return {
        id: `pc-${c.id}`,
        label,
        sub: isDM ? "Direct message" : "Group",
        img: other ? userAvatar(other) : undefined,
        initials: other ? undefined : initials(label),
        badge: mentions ? String(mentions) : unread ? "new" : undefined,
        tone: mentions ? "danger" : undefined,
        onA: () => openChannel(null, c.id),
        onY: () => { hide(); A.callDM(c.id); },
    };
}

function friendItem({ user, status }: { user: any; status: string; }): Item {
    const vs = A.voiceStateFor(user.id);
    const live = vs?.selfStream;
    return {
        id: `f-${user.id}`,
        label: A.displayName(user),
        sub: live ? "Live" : vs ? "In voice" : status,
        tone: live ? "live" : vs ? "ok" : status === "offline" ? undefined : "accent",
        img: userAvatar(user),
        onA: async () => { const dm = await A.openDM(user.id); if (dm) openChannel(null, dm); },
        onY: async () => { const dm = await A.openDM(user.id); hide(); if (dm) await A.callDM(dm); else toast("Couldn't open the DM"); },
    };
}

function voiceChannelItem(c: any, withGuild: boolean): Item {
    const ms = A.voiceMembers(c.id);
    const here = c.id === A.currentVoiceChannelId();
    const g = withGuild && c.guild_id ? GuildStore.getGuild(c.guild_id) : null;
    return {
        id: `vc-${c.id}`,
        label: `🔊 ${c.name}`,
        sub: (g ? g.name + " · " : "") + (ms.length ? names(ms) : "empty"),
        img: g ? guildIcon(g) : undefined,
        initials: g ? initials(g.name) : "🔊",
        badge: here ? "HERE" : ms.length ? String(ms.length) : undefined,
        tone: here ? "ok" : undefined,
        onA: () => here ? (tab = "voice", render()) : joinAndShowVoice(c.id),
    };
}

/* ---------- views ---------- */

function homeView(): Section[] {
    const out: Section[] = [];
    const vc = A.currentVoiceChannel();
    const recentVc = A.recentVoiceChannels().map((c: any) =>
        c.id === vc?.id ? { ...voiceChannelItem(c, true), onA: () => { tab = "voice"; render(); } } : voiceChannelItem(c, true));
    out.push({ title: "Recent voice channels", layout: "shelf", items: recentVc, empty: "Voice channels you join will show up here" });

    const recent = ChannelStore.getSortedPrivateChannels().slice(0, 8).map(privateChannelItem);
    out.push({ title: "Recent messages", layout: "shelf", items: recent });

    const online = A.friends().filter(f => f.status !== "offline").slice(0, 12).map(friendItem);
    out.push({ title: "Friends online", layout: "shelf", items: online, empty: "No friends online" });

    out.push({
        title: "More",
        layout: "shelf",
        items: [
            { id: "m-classic", label: "Full Discord", sub: "Everything else · R3", initials: "🖥", onA: () => onClassic?.() },
            { id: "m-settings", label: "Discord settings", sub: "Opens Discord's settings", initials: "⚙", onA: () => { onClassic?.(); setTimeout(() => SettingsRouter.openUserSettings(), 100); } },
        ],
    });
    return out;
}

function friendsView(): Section[] {
    const all = A.friends();
    return [
        { title: "Online  ·  A message · Y call", layout: "small", items: all.filter(f => f.status !== "offline").map(friendItem), empty: "No friends online" },
        { title: "Offline", layout: "small", items: all.filter(f => f.status === "offline").map(friendItem) },
    ];
}

function serversView(): Section[] {
    if (drillGuild) return guildView(drillGuild);
    const guilds = (SortedGuildStore.getFlattenedGuildIds?.() ?? Object.keys(GuildStore.getGuilds()))
        .map(id => GuildStore.getGuild(id)).filter(Boolean);
    return [{
        title: "Servers",
        layout: "tiles",
        items: guilds.map((g: any) => {
            const ppl = A.voiceChannelsForGuild(g.id).reduce((n, c) => n + A.voiceMembers(c.id).length, 0);
            return {
                id: `g-${g.id}`,
                label: g.name,
                img: guildIcon(g),
                initials: initials(g.name),
                sub: ppl ? `${ppl} in voice` : undefined,
                tone: ppl ? "ok" as const : undefined,
                onA: () => { drillGuild = g.id; render(); },
            };
        }),
    }];
}

function guildView(guildId: string): Section[] {
    const g = GuildStore.getGuild(guildId);
    const text = (GuildChannelStore.getChannels(guildId)?.SELECTABLE ?? [])
        .map((c: any) => c.channel)
        .filter((c: any) => c && c.type !== 4);
    return [
        {
            title: `${g?.name ?? "Server"}  ·  B back`,
            layout: "list",
            items: text.map((c: any) => {
                const m = ReadStateStore.getMentionCount(c.id);
                const unread = ReadStateStore.hasUnread(c.id);
                return {
                    id: `t-${c.id}`,
                    label: `# ${c.name}`,
                    badge: m ? String(m) : unread ? "new" : undefined,
                    tone: m ? "danger" as const : unread ? "accent" as const : undefined,
                    onA: () => openChannel(guildId, c.id),
                };
            }),
        },
        { title: "Voice channels", layout: "list", items: A.voiceChannelsForGuild(guildId).map(c => voiceChannelItem(c, false)) },
    ];
}

function voiceView(): Section[] {
    const vc = A.currentVoiceChannel();
    const out: Section[] = [];
    if (vc) {
        const live = !!A.myActiveStream();
        out.push({
            title: `In voice: ${vc.name || "Call"}`,
            layout: "small",
            items: [
                { id: "mute", label: A.isSelfMute() ? "Unmute" : "Mute", tone: A.isSelfMute() ? "danger" : undefined, initials: "🎙", onA: () => A.toggleSelfMute() },
                { id: "deaf", label: A.isSelfDeaf() ? "Undeafen" : "Deafen", tone: A.isSelfDeaf() ? "danger" : undefined, initials: "🎧", onA: () => A.toggleSelfDeaf() },
                {
                    id: "golive", label: live ? "Stop Go Live" : "Go Live", sub: live ? "You're live" : "Suggested game", tone: live ? "live" : undefined, initials: "📡",
                    onA: async () => toast(live ? await A.stopGoLive() : await A.startGoLive(settingsRef.autoConfirmGoLive)),
                },
                { id: "chat", label: "Open chat", initials: "💬", onA: () => openChannel(vc.guild_id ?? null, vc.id) },
                { id: "leave", label: "Disconnect", tone: "danger", initials: "✕", onA: () => A.leaveVoice() },
            ],
        });
        const myId = A.me()?.id;
        const members = A.voiceMembers(vc.id).filter(m => m.user.id !== myId);
        const watch = async (id: string) => {
            const msg = await A.watchStream(id);
            toast(msg);
            if (msg === "Watching") { hide(); onEnterChat?.(); }
        };
        const streamers = members.filter(m => m.state.selfStream);
        if (streamers.length) out.push({
            title: "Live in this channel  ·  A watch",
            layout: "small",
            items: streamers.map(({ user }) => ({
                id: `s-${user.id}`,
                label: `Watch ${A.displayName(user)}`,
                sub: "Streaming",
                tone: "live" as const,
                img: userAvatar(user),
                onA: () => watch(user.id),
            })),
        });
        out.push({
            title: "Volume  ·  ◀ ▶ adjust · A mute for me · X reset",
            layout: "list",
            empty: "Nobody else here yet",
            items: members.map(({ user, state }) => {
                const vol = A.getLocalVolume(user.id);
                const muted = A.isLocalMute(user.id);
                const flags = [state.selfStream && "live", state.selfDeaf && "deafened", state.selfMute && "muted"].filter(Boolean).join(" · ");
                return {
                    id: `u-${user.id}`,
                    label: A.displayName(user),
                    sub: flags || undefined,
                    img: userAvatar(user),
                    meter: vol,
                    badge: muted ? "MUTED" : `${vol}%`,
                    tone: muted ? "danger" as const : state.selfStream ? "live" as const : undefined,
                    onLeft: () => A.setLocalVolume(user.id, vol - settingsRef.volumeStep),
                    onRight: () => A.setLocalVolume(user.id, vol + settingsRef.volumeStep),
                    onX: () => A.setLocalVolume(user.id, 100),
                    ...(state.selfStream ? { onY: () => watch(user.id), yLabel: "Watch" } : {}),
                    onA: () => A.toggleLocalMute(user.id),
                };
            }),
        });
    }
    const gid = vc?.guild_id ?? A.selectedGuildId();
    const chans = A.voiceChannelsForGuild(gid);
    if (chans.length)
        out.push({ title: vc ? "Switch channel" : "Join a voice channel", layout: "list", items: chans.map(c => voiceChannelItem(c, false)) });
    else if (!vc)
        out.push({ title: "Not in voice", layout: "list", items: [], empty: "Pick a server in Servers to see its voice channels, or pick one from Recent voice channels on Home" });
    return out;
}

/* ---------- rendering ---------- */

const esc = (s: string) => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function render() {
    if (!root || !open) return;
    const sections = tab === "home" ? homeView() : tab === "friends" ? friendsView() : tab === "servers" ? serversView() : voiceView();
    items = sections.flatMap(s => s.items);
    const key = viewKey();
    if (!items.some(i => i.id === selected[key])) selected[key] = items[0]?.id;
    const sel = selected[key];

    const live = !!A.myActiveStream();
    const vc = A.currentVoiceChannel();
    const clock = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const tabsHtml = `<div class="vc-gpn-brand">Discord</div>`
        + `<div class="vc-gpn-pills"><kbd>LB</kbd>`
        + TABS.map(t => `<span data-tab="${t}" class="${t === tab ? "on" : ""}">${TAB_NAMES[t]}</span>`).join("")
        + `<kbd>RB</kbd></div>`
        + `<div class="vc-gpn-status">${vc ? `<b class="ok">● ${esc(vc.name || "Call")}</b>` : ""}${live ? '<b class="live">LIVE</b>' : ""}${A.isSelfMute() ? "<span>🔇</span>" : ""}<span>${clock}</span></div>`;

    // Selection isn't part of the HTML: it's a class toggled below, so moving
    // doesn't rebuild the DOM (which would reset shelf scroll and skip the
    // lift transition).
    const html = sections.map(s => {
        const body = s.items.length
            ? s.items.map(it => itemHtml(it, false, s.layout)).join("")
            : `<div class="vc-gpn-empty">${esc(s.empty ?? "Nothing here")}</div>`;
        return `<section><h3>${esc(s.title)}</h3><div class="vc-gpn-${s.layout}">${body}</div></section>`;
    }).join("");

    if (header.innerHTML !== tabsHtml) header.innerHTML = tabsHtml;
    const cur = items.find(i => i.id === sel);
    const hints = [
        cur?.onLeft ? glyph("dpad", "◀ ▶", "Volume") : "",
        cur?.onX ? glyph("x", "X", "Reset") : "",
        cur?.onY ? glyph("y", "Y", cur.yLabel ?? "Call") : "",
        glyph("view", "⧉", "Help"),
        cur?.onA ? glyph("a", "A", cur.onLeft ? "Mute" : "Select") : "",
        glyph("b", "B", tab === "servers" && drillGuild ? "Back" : tab === "home" ? "Quit" : "Home"),
    ].join("");
    if (footer.innerHTML !== hints) footer.innerHTML = hints;
    if (html !== lastHtml) {
        // keep each shelf's horizontal position across a rebuild of the same view
        const keep = key === lastView ? [...content.querySelectorAll<HTMLElement>(".vc-gpn-shelf")].map(s => s.scrollLeft) : [];
        content.innerHTML = html;
        lastHtml = html;
        content.querySelectorAll<HTMLElement>(".vc-gpn-shelf").forEach((s, i) => { if (keep[i]) s.scrollLeft = keep[i]; });
    }
    for (const el of content.querySelectorAll<HTMLElement>(".vc-gpn-sel"))
        if (el.dataset.id !== sel) el.classList.remove("vc-gpn-sel");
    const selEl = sel ? content.querySelector<HTMLElement>(`.vc-gpn-it[data-id="${CSS.escape(sel)}"]`) : null;
    selEl?.classList.add("vc-gpn-sel");
    // only scroll when the selection moves, so the periodic refresh doesn't
    // fight the right stick
    if (selEl && key + sel !== lastScrolledTo) {
        lastScrolledTo = key + sel;
        scrollToSelected(selEl, key === lastView);
    }
    lastView = key;
}

/** Ease a shelf to `to` (Big Picture style). Looks the shelf up by index each
 *  frame, so a re-render mid-animation doesn't strand it on a detached node. */
let shelfAnim = 0;
function animateShelf(shelf: HTMLElement, to: number, animate: boolean) {
    cancelAnimationFrame(shelfAnim);
    to = Math.round(Math.max(0, Math.min(to, shelf.scrollWidth - shelf.clientWidth)));
    const from = shelf.scrollLeft;
    if (!animate || Math.abs(to - from) < 2 || matchMedia("(prefers-reduced-motion: reduce)").matches) {
        shelf.scrollLeft = to;
        return;
    }
    const idx = [...content.querySelectorAll(".vc-gpn-shelf")].indexOf(shelf);
    const start = performance.now(), dur = 240;
    const step = (now: number) => {
        const s = content.querySelectorAll<HTMLElement>(".vc-gpn-shelf")[idx];
        if (!s) return;
        const t = Math.min(1, (now - start) / dur);
        s.scrollLeft = from + (to - from) * (1 - (1 - t) ** 3); // ease-out cubic
        if (t < 1) shelfAnim = requestAnimationFrame(step);
    };
    shelfAnim = requestAnimationFrame(step);
}

/**
 * One scroll calculation (no scrollIntoView: with smooth scrolling its result
 * isn't visible yet, so follow-up adjustments read stale positions and fight).
 *  - first row of the first section: scroll to the very top
 *  - otherwise: keep the item fully visible, and show its section heading too
 *    when that still leaves the item on screen
 *  - shelves: centre the item horizontally
 */
function scrollToSelected(el: HTMLElement, animate: boolean) {
    const pad = 24;
    const sr = scroller.getBoundingClientRect();
    const toContent = (y: number) => y - sr.top + scroller.scrollTop;
    // offsetTop/offsetHeight ignore the focus "lift" transform
    const r = el.getBoundingClientRect();
    const itemTop = toContent(r.top) , itemBottom = itemTop + el.offsetHeight;
    const sec = el.closest("section");
    const first = sec?.querySelector<HTMLElement>(".vc-gpn-it");
    const inFirstRow = !!first && Math.abs(el.offsetTop - first.offsetTop) < 4;
    const view = scroller.clientHeight;
    const cur = scroller.scrollTop;

    let target = cur;
    if (sec && sec === content.querySelector("section") && inFirstRow) {
        target = 0;
    } else {
        if (itemBottom + pad > cur + view) target = itemBottom + pad - view;
        if (itemTop - pad < target) target = itemTop - pad;
        const head = sec ? toContent(sec.getBoundingClientRect().top) - 8 : null;
        if (head != null && head < target && itemBottom + pad - head <= view) target = head;
    }
    target = Math.max(0, Math.round(target));
    if (Math.abs(target - scroller.scrollTop) > 1) scroller.scrollTo({ top: target });

    const shelf = el.parentElement;
    if (shelf?.classList.contains("vc-gpn-shelf")) {
        // the shelf is position:relative, so offsetLeft is within its scroll
        // content and ignores the lift transform
        animateShelf(shelf, el.offsetLeft - (shelf.clientWidth - el.offsetWidth) / 2, animate);
    }
}

const glyph = (cls: string, k: string, label: string) => `<span data-btn="${cls}"><i class="g-${cls}">${k}</i>${label}</span>`;

/* ---------- touch / mouse ---------- */

// Tap a tile = select it and press A. Tap a tab = switch. Tap a footer hint = that button.
function onTap(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const tabEl = t.closest<HTMLElement>("[data-tab]");
    if (tabEl) return show(tabEl.dataset.tab as Tab);
    const btn = t.closest<HTMLElement>("[data-btn]")?.dataset.btn;
    if (btn) {
        if (btn === "b") { if (!back() && !backToHome() && !(quitFn && backAtHome(quitFn))) { hide(); onEnterChat?.(); } return; }
        if (btn === "a" || btn === "x" || btn === "y") return handle(btn);
        return;
    }
    const it = t.closest<HTMLElement>(".vc-gpn-it");
    if (!it?.dataset.id) return;
    const item = items.find(i => i.id === it.dataset.id);
    selected[viewKey()] = it.dataset.id;
    // volume rows: tap the bar to set volume where you tapped
    const meter = it.querySelector<HTMLElement>(".vc-gpn-meter");
    if (item?.id.startsWith("u-") && meter && t.closest(".vc-gpn-meter")) {
        const r = meter.getBoundingClientRect();
        A.setLocalVolume(item.id.slice(2), Math.round(((e.clientX - r.left) / r.width) * 200 / 5) * 5);
    } else {
        item?.onA?.();
    }
    render();
    setTimeout(render, 150);
}

function itemHtml(it: Item, sel: boolean, layout: Section["layout"]) {
    const art = it.img
        ? `<img src="${esc(it.img)}">`
        : `<div class="vc-gpn-ini">${esc(it.initials ?? initials(it.label))}</div>`;
    const meter = it.meter != null
        ? `<div class="vc-gpn-meter"><div style="width:${Math.min(100, it.meter / 2)}%"></div><i></i></div>` : "";
    return `<div class="vc-gpn-it${sel ? " vc-gpn-sel" : ""}${it.tone ? " t-" + it.tone : ""}" data-id="${esc(it.id)}">`
        + art
        + `<div class="vc-gpn-txt"><div class="vc-gpn-label">${esc(it.label)}</div>`
        + (it.sub ? `<div class="vc-gpn-sub">${esc(it.sub)}</div>` : "")
        + meter + `</div>`
        + (it.badge ? `<div class="vc-gpn-badge">${esc(it.badge)}</div>` : "")
        + `</div>`;
}

/* ---------- input ---------- */

function moveSpatial(dir: Dir) {
    const key = viewKey();
    const els = [...content.querySelectorAll<HTMLElement>(".vc-gpn-it")];
    const cur = els.find(e => e.dataset.id === selected[key]);
    if (!cur) { selected[key] = els[0]?.dataset.id ?? ""; return; }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best: HTMLElement | null = null, bestScore = Infinity;
    for (const el of els) {
        if (el === cur) continue;
        const r = el.getBoundingClientRect();
        const bx = r.left + r.width / 2, by = r.top + r.height / 2;
        const dx = bx - ax, dy = by - ay;
        const vertical = dir === "up" || dir === "down";
        const main = vertical ? (dir === "up" ? -dy : dy) : (dir === "left" ? -dx : dx);
        if (main <= 4) continue;
        const cross = Math.abs(vertical ? dx : dy);
        // prefer same row/column, then nearest
        const score = main + cross * 3;
        if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) selected[key] = best.dataset.id!;
}

export function handle(btn: Dir | "a" | "x" | "y") {
    if (confirm) return confirmHandle(btn);
    const it = items.find(i => i.id === selected[viewKey()]);
    switch (btn) {
        case "left": case "right":
            if (it?.onLeft && it.onRight) (btn === "left" ? it.onLeft : it.onRight)();
            else moveSpatial(btn);
            break;
        case "up": case "down": moveSpatial(btn); break;
        case "a": it?.onA?.(); break;
        case "x": it?.onX?.(); break;
        case "y": it?.onY?.(); break;
    }
    render();
    setTimeout(render, 150); // stores update async
}

/* ---------- voice dock (shown over chat while in voice) ---------- */

export function updateDock() {
    const vc = A.currentVoiceChannel();
    if (open || !vc) {
        if (dock) dock.style.display = "none";
        return;
    }
    if (!dock) {
        dock = document.createElement("div");
        dock.className = "vc-gpn-dock";
        document.body.appendChild(dock);
    }
    const n = A.voiceMembers(vc.id).length;
    const live = !!A.myActiveStream();
    const html = `<b class="ok">● ${esc(vc.name || "Call")}</b><span>${n} in voice</span>`
        + (live ? '<b class="live">LIVE</b>' : "")
        + (A.isSelfMute() ? "<span>🔇 muted</span>" : "")
        + `<em>Y mute · B menu · RB/LB voice</em>`;
    if (dock.innerHTML !== html) dock.innerHTML = html;
    dock.style.display = "";
}

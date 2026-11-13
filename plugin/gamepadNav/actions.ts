/*
 * GamepadNav: wrappers around Discord's internal modules.
 * Every lookup is lazy and guarded, so a Discord update that renames a module
 * breaks only the one feature that uses it, never the whole plugin.
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { findByProps } from "@webpack";
import {
    ApplicationStreamingStore,
    ChannelActionCreators,
    ChannelStore,
    GuildChannelStore,
    MediaEngineStore,
    NavigationRouter,
    PresenceStore,
    RelationshipStore,
    SelectedChannelStore,
    SelectedGuildStore,
    UserStore,
    VoiceStateStore,
} from "@webpack/common";

export const log = new Logger("GamepadNav", "#7ad3ff");

const cache: Record<string, any> = {};
function mod(...props: string[]) {
    const key = props.join(",");
    if (cache[key] !== undefined) return cache[key];
    try {
        cache[key] = findByProps(...props) ?? null;
    } catch (e) {
        log.error("module not found", key, e);
        cache[key] = null;
    }
    return cache[key];
}

const voiceActions = () => mod("selectVoiceChannel", "selectChannel");
const audioActions = () => mod("setLocalVolume", "toggleSelfMute");

export const me = () => UserStore.getCurrentUser();

/* ---------- voice ---------- */

export const currentVoiceChannelId = () => SelectedChannelStore.getVoiceChannelId() ?? null;
export const currentVoiceChannel = () => {
    const id = currentVoiceChannelId();
    return id ? ChannelStore.getChannel(id) : null;
};

export function joinVoice(channelId: string) {
    voiceActions()?.selectVoiceChannel(channelId);
}

export function leaveVoice() {
    voiceActions()?.selectVoiceChannel(null);
}

export function voiceMembers(channelId: string) {
    const states = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};
    return Object.values(states as Record<string, any>)
        .map(s => ({ state: s, user: UserStore.getUser(s.userId) }))
        .filter(m => m.user);
}

export const voiceStateFor = (userId: string): any =>
    (VoiceStateStore as any).getVoiceStateForUser?.(userId) ?? null;

export function voiceChannelsForGuild(guildId: string | null) {
    if (!guildId) return [];
    const vocal = GuildChannelStore.getChannels(guildId)?.VOCAL ?? [];
    return vocal.map((c: any) => c.channel).filter(Boolean);
}

export const selectedGuildId = () => SelectedGuildStore.getGuildId() ?? null;

export const getLocalVolume = (userId: string) => MediaEngineStore.getLocalVolume(userId) ?? 100;
export const isLocalMute = (userId: string) => !!MediaEngineStore.isLocalMute?.(userId);

export function setLocalVolume(userId: string, volume: number) {
    const v = Math.max(0, Math.min(200, Math.round(volume)));
    audioActions()?.setLocalVolume(userId, v);
}

export function toggleLocalMute(userId: string) {
    audioActions()?.toggleLocalMute?.(userId);
}

export const isSelfMute = () => !!MediaEngineStore.isSelfMute?.();
export const isSelfDeaf = () => !!MediaEngineStore.isSelfDeaf?.();
export const toggleSelfMute = () => audioActions()?.toggleSelfMute();
export const toggleSelfDeaf = () => audioActions()?.toggleSelfDeaf?.();

/* ---------- friends / DMs / calls ---------- */

const STATUS_ORDER: Record<string, number> = { online: 0, streaming: 0, idle: 1, dnd: 2, offline: 3, invisible: 3 };

export function friends() {
    return RelationshipStore.getFriendIDs()
        .map(id => ({ user: UserStore.getUser(id), status: PresenceStore.getStatus(id) ?? "offline" }))
        .filter(f => f.user)
        .sort((a, b) =>
            (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3)
            || displayName(a.user).localeCompare(displayName(b.user)));
}

export function displayName(user: any, guildId?: string | null) {
    return user?.globalName || user?.username || "Unknown";
}

async function waitFor<T>(fn: () => T | null | undefined, ms = 3000): Promise<T | null> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = fn();
        if (v) return v;
        await new Promise(r => setTimeout(r, 100));
    }
    return null;
}

export async function openDM(userId: string) {
    const existing = ChannelStore.getDMFromUserId(userId);
    if (existing) {
        NavigationRouter.transitionTo(`/channels/@me/${existing}`);
        return existing;
    }
    try {
        await ChannelActionCreators.openPrivateChannel(userId);
    } catch (e) {
        log.error("openPrivateChannel failed", e);
    }
    return waitFor(() => ChannelStore.getDMFromUserId(userId));
}

/**
 * Start a voice call in a DM. Prefer pressing Discord's own "Start Voice Call"
 * header button, since that is the exact path a mouse click takes (it rings the
 * other person). Fall back to joining the DM's voice channel directly.
 */
export async function callDM(channelId: string) {
    NavigationRouter.transitionTo(`/channels/@me/${channelId}`);
    const btn = await waitFor(() => document.querySelector<HTMLElement>(
        '[aria-label="Start Voice Call"], [aria-label="Start Call"]'), 2500);
    if (btn) {
        btn.click();
        return;
    }
    log.warn("call button not found, joining DM voice directly");
    joinVoice(channelId);
    try { mod("ring", "stopRinging")?.ring(channelId); } catch { /* optional */ }
}

export function currentTextChannel() {
    const id = SelectedChannelStore.getChannelId();
    return id ? ChannelStore.getChannel(id) : null;
}

export const isPrivateChannel = (c: any) => c && (c.type === 1 || c.type === 3);

/* ---------- Go Live ---------- */

export const myActiveStream = () => ApplicationStreamingStore.getCurrentUserActiveStream?.() ?? null;

function findButton(re: RegExp, root: ParentNode = document) {
    for (const el of root.querySelectorAll<HTMLElement>('button, [role="button"]')) {
        const label = el.getAttribute("aria-label") ?? el.textContent ?? "";
        if (re.test(label.trim())) return el;
    }
    return null;
}

/**
 * Go Live using the game Discord already suggests while you're in voice
 * ("Stream Rocket League"). This clicks the same button a mouse would, then
 * optionally presses "Go Live" in the confirmation modal.
 */
export async function startGoLive(autoConfirm: boolean): Promise<string> {
    if (!currentVoiceChannelId()) return "Join a voice channel first";
    if (myActiveStream()) return "Already live";

    const suggested = findButton(/^Stream\s+.+/i);
    const generic = findButton(/^Share Your Screen$/i);
    const btn = suggested ?? generic;
    if (!btn) return "Couldn't find Discord's stream button";
    btn.click();

    if (!autoConfirm) return suggested ? "Pick Go Live to start" : "Pick a window, then Go Live";

    const goLive = await waitFor(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')].pop();
        return dialog ? findButton(/^Go Live$/i, dialog) : null;
    }, 4000);
    if (goLive && !(goLive as HTMLButtonElement).disabled) {
        goLive.click();
        return "Going live";
    }
    return "Pick a source, then Go Live";
}

export async function stopGoLive(): Promise<string> {
    const stream = myActiveStream();
    if (!stream) return "You're not live";
    const btn = findButton(/^Stop Streaming$/i);
    if (btn) {
        btn.click();
        return "Stream stopped";
    }
    try {
        const streamKey = stream.ownerId && stream.channelId
            ? (stream.guildId ? `guild:${stream.guildId}:${stream.channelId}:${stream.ownerId}` : `call:${stream.channelId}:${stream.ownerId}`)
            : null;
        const m = mod("stopStream");
        if (m && streamKey) {
            m.stopStream(streamKey);
            return "Stream stopped";
        }
    } catch (e) {
        log.error("stopStream failed", e);
    }
    return "Couldn't stop stream, use the voice panel";
}

/* ---------- recent voice channels (Discord keeps no history, so we do) ---------- */

const RECENT_KEY = "GamepadNav_recentVoice";
let recentVoice: string[] = [];

export async function loadRecentVoice() {
    recentVoice = (await DataStore.get<string[]>(RECENT_KEY)) ?? [];
}

export function recordVoiceJoin(channelId: string | null | undefined) {
    if (!channelId) return;
    recentVoice = [channelId, ...recentVoice.filter(id => id !== channelId)].slice(0, 12);
    DataStore.set(RECENT_KEY, recentVoice);
}

/** Recently joined server voice channels that still exist, newest first. */
export const recentVoiceChannels = () =>
    recentVoice.map(id => ChannelStore.getChannel(id)).filter((c: any) => c?.guild_id);

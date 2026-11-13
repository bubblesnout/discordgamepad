# GamepadNav: Discord with a controller

A Vencord userplugin + couch theme for using Discord on the ROG Xbox Ally X (or any
XInput pad) from Steam Big Picture, without Steam Input mouse emulation.

Prototype. Priorities: voice + navigation first, then friends/calls, chat, Go Live.

## Install

1. Close Discord fully (tray icon > Quit).
2. In PowerShell:
   ```powershell
   cd path\to\discordgamepad
   .\setup.ps1 -Inject
   ```
   The Vencord installer asks which Discord to patch: pick the normal (Stable) one.
3. Start Discord, open **User Settings > Vencord > Plugins**, enable **GamepadNav**.
   (Settings are fine with a mouse/touchscreen.)

To undo: `cd vencord; pnpm uninject`.

After editing the plugin: `.\setup.ps1 -Quick`, then Ctrl+R in Discord.

## Steam setup (important)

Steam Input must not turn the pad into a mouse, or Discord never sees a controller.
In Big Picture, open Discord's controller settings (the non-Steam shortcut) and either:

- set **Steam Input** to **Disabled** for Discord, or
- keep it enabled but pick the **Gamepad** layout template (not "Mouse"/"Web Browser").

The second option keeps Steam chords like **Steam + X** for the on-screen keyboard,
which is how you type messages.

## Controls

| Button | Does |
|---|---|
| D-pad / left stick | Move the focus ring |
| A | Select (same as a click) |
| B | Back: close menu/modal; in chat, open the menu |
| X | Context menu (right click) |
| Y | In a DM: start a call. In voice: mute/unmute |
| LB / RB | Open the menu / switch tabs: Home Â· Friends Â· Servers Â· Voice |
| Start | Jump to the chat box / send message |
| Right stick, LT / RT | Scroll, page up / page down |
| R3 (click right stick) | Full Discord UI (sidebars, settings) and back |
| View | Controls help |

**10-foot menu**: a full-screen, console-style launcher drawn by the plugin. Home shows
voice channels with people in them, recent DMs and online friends as tiles. Servers is a
grid of server tiles; A opens its text and voice channels. Picking a text channel drops
you into Discord's chat, full width with the sidebars hidden ("10-foot mode" setting).
While you're in voice a small dock shows the call over the chat.

**Voice tab**: mute, deafen, Go Live / stop, disconnect; every member
with a volume bar (â—€ â–¶ adjusts 0â€“200%, A mutes them for you, X resets to 100%); and the
server's voice channels to join or switch to.

**Friends tab**: friends sorted online-first. A opens the DM, Y calls them.

**Go Live** uses the game Discord already suggests while you're in voice
("Stream Rocket League"). It presses Discord's own button, then Go Live in the dialog
(turn off "auto confirm" in plugin settings to choose yourself).

## How it works

- `plugin/gamepadNav/index.ts`: polls `navigator.getGamepads()` every 16 ms, button
  mapping, repeat, sections.
- `nav.ts`: focus ring overlay + spatial navigation over Discord's real DOM (buttons,
  links, list items, menus). Menus and modals capture navigation while open.
- `shell.ts`: the full-screen menu (tabs, tiles, voice volumes) and the voice dock.
- `actions.ts`: Discord internals (voice join/leave, `setLocalVolume`, DMs, calls,
  streams). Each lookup is guarded so a Discord update breaks one feature, not all.
- `couch.css`: optional theme (bigger text/targets, hides Nitro/shop/sticker clutter).
- `style.css`: ring, panels, toasts.

`vencord/` is a git-ignored clone of Vencord. `setup.ps1` copies `plugin/gamepadNav`
into `vencord/src/userplugins/gamepadNav` before building (a link doesn't work, since
esbuild then can't resolve Vencord's import aliases), so edit the copy in `plugin/`.

## Known gaps

- Labels like "Start Voice Call", "Stream â€¦", "Go Live" are matched in English.
- Typing needs the Steam keyboard (Steam + X) or the Windows touch keyboard.
- Settings screens are mouse/touch only.

## Everyday setup (Steam)

- Steam shortcut target: `%LOCALAPPDATA%\DiscordHost\DiscordHost.exe` (no launch options).
  `.\setup.ps1` rebuilds and reinstalls it there.
- The host always launches the newest `app-*` Discord, so Discord updates don't break it.
- A Discord update can remove Vencord. If the menu stops appearing, quit Discord and run
  `.\setup.ps1 -Inject`. Keep the `vencord` folder: Discord loads the build from it.
- Optional: turn off "Open Discord" on Windows startup, so the host doesn't have to
  restart an already-running Discord.

## Licence

GPL-3.0, the same as Vencord. See [LICENSE](LICENSE).


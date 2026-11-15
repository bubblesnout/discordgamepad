# GamepadNav: Discord with a controller

A Vencord userplugin and couch theme for using Discord on the ROG Xbox Ally X (or any
XInput pad) from Steam Big Picture, without Steam Input mouse emulation. It adds a
Steam Big Picture style 10-foot menu on top of Discord.

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

## Steam setup

Add Discord to Steam as a non-Steam game:

- Target: `%LOCALAPPDATA%\Discord\Update.exe`
- Launch options: `--processStart Discord.exe`

That's Discord's own launcher, so it always starts the newest version.

Steam Input must not turn the pad into a mouse, or Discord never sees a controller.
In Big Picture, open the shortcut's controller settings and either:

- set **Steam Input** to **Disabled**, or
- keep it enabled but pick the **Gamepad** layout template (not "Mouse"/"Web Browser").

The Steam overlay doesn't work over Discord (Chromium draws in a separate GPU
process the overlay can't attach to). The Steam button still takes you back to Big
Picture.

## Controls

| Button | Does |
|---|---|
| D-pad / left stick | Move the focus ring |
| A | Select (same as a click) |
| B | Back. In chat: open the menu. On a tab: go Home. On Home: quit Discord? |
| X | Context menu (right click) |
| Y | In a DM: start a call. In voice: mute/unmute |
| LB / RB | Open the menu / switch tabs: You · Home · Friends · Servers · Voice · Settings |
| Start | Jump to the chat box / send message |
| Right stick, LT / RT | Scroll, page up / page down |
| R3 (click right stick) | Full Discord UI (sidebars, settings) and back |
| View | Controls help |

**10-foot menu**: a full-screen launcher drawn by the plugin. Home shows recent voice
channels, recent DMs and online friends.
Servers is a grid of server tiles; A opens its text and voice channels. Picking a text
channel drops you into Discord's chat, full width with the sidebars hidden ("10-foot
mode" setting). While you're in voice a small dock shows the call over the chat.

**Voice tab**: mute, deafen, Go Live / stop, disconnect; every member with a volume bar
(◀ ▶ adjusts 0–200%, A mutes them for you, X resets to 100%); and the server's voice
channels to join or switch to.

**Friends tab**: friends sorted online-first. A opens the DM, Y calls them.

**Go Live** uses the game Discord already suggests while you're in voice
("Stream Rocket League"). It presses Discord's own button, then Go Live in the dialog
(turn off "auto confirm" in plugin settings to choose yourself).

**Typing**: the Windows touch keyboard (or Steam + X with Steam Input on). Discord
shrinks to sit above the touch keyboard while it's open.

**Profile tab** (the pill left of Home, with your status dot and name): set your status
(online, idle, do not disturb, invisible), open Full Discord or Discord's settings, or quit.

**Settings tab** (far right): font and every plugin setting (sizes, spacing, toggles),
changeable with the controller. Fonts offered are readable Windows fonts that are
installed, plus anything you drop into a `fonts/` folder in the repo (git-ignored, so
licensed fonts like Motiva Sans never get committed). Files are named like
`FamilyNameBold.ttf`; the family and weight come from the name.

**Scale** (plugin settings): tiles per row, list row/icon size, menu text size and chat
text size, each separately.

**Fullscreen**: Discord goes true fullscreen (like F11) on start, so the handheld
pull-out taskbar stays out of the way. Toggle in the plugin settings.

## How it works

- `plugin/gamepadNav/index.ts`: polls `navigator.getGamepads()` every 16 ms, button
  mapping, repeat, menu/tab switching.
- `nav.ts`: focus ring overlay + spatial navigation over Discord's real DOM (buttons,
  links, list items, menus). Menus and modals capture navigation while open.
- `shell.ts`: the full-screen menu (tabs, tiles, voice volumes), quit dialog, voice dock.
- `actions.ts`: Discord internals (voice join/leave, `setLocalVolume`, DMs, calls,
  streams). Each lookup is guarded so a Discord update breaks one feature, not all.
- `keyboard.ts`: touch keyboard handling (VirtualKeyboard API).
- `native.ts`: Electron main-process helpers (quit, fullscreen, touch keyboard, local fonts).
- `fonts.ts`: font switcher. `flags.ts`: body classes that survive Discord rewriting them.
- `couch.css`: optional theme (bigger text/targets, hides Nitro/shop/sticker clutter,
  10-foot mode layout). `style.css`: ring, menu, toasts.

`vencord/` is a git-ignored clone of Vencord. `setup.ps1` copies `plugin/gamepadNav`
into `vencord/src/userplugins/gamepadNav` before building (a link doesn't work, since
esbuild then can't resolve Vencord's import aliases), so edit the copy in `plugin/`.

## Keeping it working

- A Discord update can remove Vencord. If the menu stops appearing, quit Discord and
  run `.\setup.ps1 -Inject`.
- Keep the `vencord` folder: Discord loads the build from it.

## Known gaps

- Labels like "Start Voice Call", "Stream …", "Go Live" are matched in English.
- Settings screens are mouse/touch only.

## Licence

GPL-3.0, the same as Vencord. See [LICENSE](LICENSE).

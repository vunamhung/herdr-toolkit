# herdr-toolkit

Personal customizations for the [Herdr](https://herdr.dev) desktop app.

## What's here

| Path | Installs to | What it does |
|---|---|---|
| `mods/claude-limits-status/` | `~/.config/herdr-app/mods/claude-limits-status/` | Herdr's bottom status bar (clone of `workspace-status` 0.1.16) plus Claude Code's model, usage limits and context window usage next to the agents count: `6 agents │ Opus 5.5 (medium) 17%/5h 3h35m 7%/7d 2d13h 42%/ctx`. Only the percentages are colored (green, yellow ≥ 60 %, red ≥ 85 %). |
| `mods/vnh-chrome/` | `~/.config/herdr-app/mods/vnh-chrome/` | Clone of Herdr's `workspace-chrome` (0.1.16) without the Herdr logo and name in the sidebar's top row; search, the sidebar toggle and the window-drag area stay. |
| `mods/vnh-tabs/` | `~/.config/herdr-app/mods/vnh-tabs/` | Clone of Herdr's `tabs` (0.1.16) with a **Timeline** button after Files and Changes; it toggles the Timeline panel and is highlighted while the panel shows. Opening the Timeline (button, `⌘⇧B` or palette) closes the Files/Changes panel, and closing it reopens that panel if it was open; the left sidebar is left alone. |
| `mods/vnh-prompts/` | `~/.config/herdr-app/mods/vnh-prompts/` | Clone of the `over9k-prompts` Timeline panel without its "Timeline" title (the tab bar's button names it). `place` is `none` so Herdr does not dock an extra copy; the layout places it. |
| `mods/vnh-files/` | `~/.config/herdr-app/mods/vnh-files/` | Clone of Herdr's `files` (0.1.16) whose rows are drag sources: drag a file or folder into a terminal to type `@<path>` relative to the panel's folder (a folder ends in `/`), which Claude Code reads as a file mention. On a remote machine it stays the absolute path. Clicks still open folders and preview files. |
| `karabiner/herdr-hotkey.json` | merged into `~/.config/karabiner/karabiner.json` (selected profile) | Karabiner-Elements rule: `⌘`` ` from any app activates Herdr (`open -b dev.herdr.app`). It replaces macOS's own `⌘`` ` (cycle the windows of the front app). |
| `mods/vnh-worktree-sync/` | `~/.config/herdr-app/mods/vnh-worktree-sync/` | Opens every git worktree in a project's `.worktrees/` folder as a Herdr space (in the background), every 30 s, for the repos of the spaces already open. Herdr's sidebar nests them under their repo. Each worktree is opened once: one you close stays closed. Renders nothing; the VNH layout holds it in a 0 px sidebar block. |
| `claude/statusline.sh` | `~/.claude/statusline.sh` | Claude Code status line command. It publishes model, effort, 5h/7d usage, reset times and context % to `~/.cache/claude-statusline/limits.json` (read by the mod) and prints nothing, so the in-terminal status line is hidden. |
| `layouts/VNH.json` | `~/.config/herdr-app/layouts/VNH.json` | The **VNH** layout, based on Herdr's `main`: status bar uses `claude-limits-status`, the sidebar's top row uses `vnh-chrome`, the tab bar uses `vnh-tabs`, the Files panel uses `vnh-files`, and the sidebar footer (Settings / Add machine) is removed. Settings stays on `⌘,` and both are in the command palette (`⌘⇧P`). The Timeline panel (`vnh-prompts`) is the block `timeline`. |
| `keys/vnh.json` | merged into `~/.config/herdr-app/keys.json` | While the VNH layout shows: `⌘⇧B` toggles the Timeline panel through `vnh-tabs.timeline` (same as the tab bar's Timeline button, so Files/Changes closes and reopens in the same step) (next to Herdr's `⌘B` for the sidebar). |

## Install

```sh
./install.sh            # mods + status line script
./install.sh --layout   # also the layout + its keys, and switch Herdr to it
./install.sh --karabiner  # also the Cmd+` -> Herdr Karabiner rule (combine flags freely)
```

Existing files are backed up as `<file>.bak-<timestamp>`.

The layout also places mods that are installed separately: `chat-agents`, `gitview`, `new-chat`. Install those first, or Herdr shows empty blocks for them.

## Restore defaults

- In-terminal Claude status line: delete the `exit 0` line under "publish model + limits" in `~/.claude/statusline.sh`. The full two-line status line is still below it.
- Herdr's stock status bar: in the layout, change `"mod": "claude-limits-status"` back to `"mod": "workspace-status"`.
- Herdr's stock layout: `herdr-app do layout.switch '{"name":"main"}'`, or press `ctrl-alt-shift-escape`.

## Notes

- Several Claude Code sessions can run at once. The model and context % shown are from the session that refreshed last; the 5h and 7d limits are account-wide.
- Rate limits arrive only after a session's first API response; until then the previous values are kept.

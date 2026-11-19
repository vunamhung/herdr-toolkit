# herdr-toolkit

Personal customizations for the [Herdr](https://herdr.dev) desktop app.

## What's here

| Path | Installs to | What it does |
|---|---|---|
| `mods/claude-limits-status/` | `~/.config/herdr-app/mods/claude-limits-status/` | Herdr's bottom status bar (clone of `workspace-status` 0.1.16) plus Claude Code's model, usage limits and context window usage next to the agents count: `6 agents │ Opus 5.5 (medium) 17%/5h 3h35m 7%/7d 2d13h 42%/ctx`. Only the percentages are colored (green, yellow ≥ 60 %, red ≥ 85 %). |
| `mods/vnh-chrome/` | `~/.config/herdr-app/mods/vnh-chrome/` | Clone of Herdr's `workspace-chrome` (0.1.16) without the Herdr logo and name in the sidebar's top row; search, the sidebar toggle and the window-drag area stay. |
| `claude/statusline.sh` | `~/.claude/statusline.sh` | Claude Code status line command. It publishes model, effort, 5h/7d usage, reset times and context % to `~/.cache/claude-statusline/limits.json` (read by the mod) and prints nothing, so the in-terminal status line is hidden. |
| `layouts/VNH.json` | `~/.config/herdr-app/layouts/VNH.json` | The **VNH** layout, based on Herdr's `main`: status bar uses `claude-limits-status`, the sidebar's top row uses `vnh-chrome`, and the sidebar footer (Settings / Add machine) is removed. Settings stays on `⌘,` and both are in the command palette (`⌘⇧P`). The Timeline panel (`over9k-prompts`) is the block `timeline`. |
| `keys/vnh.json` | merged into `~/.config/herdr-app/keys.json` | While the VNH layout shows: `⌘⇧B` toggles the Timeline panel (next to Herdr's `⌘B` for the sidebar). |

## Install

```sh
./install.sh            # mods + status line script
./install.sh --layout   # also the layout + its keys, and switch Herdr to it
```

Existing files are backed up as `<file>.bak-<timestamp>`.

The layout also places mods that are installed separately: `chat-agents`, `gitview`, `new-chat`, `over9k-prompts`. Install those first, or Herdr shows empty blocks for them.

## Restore defaults

- In-terminal Claude status line: delete the `exit 0` line under "publish model + limits" in `~/.claude/statusline.sh`. The full two-line status line is still below it.
- Herdr's stock status bar: in the layout, change `"mod": "claude-limits-status"` back to `"mod": "workspace-status"`.
- Herdr's stock layout: `herdr-app do layout.switch '{"name":"main"}'`, or press `ctrl-alt-shift-escape`.

## Notes

- Several Claude Code sessions can run at once. The model and context % shown are from the session that refreshed last; the 5h and 7d limits are account-wide.
- Rate limits arrive only after a session's first API response; until then the previous values are kept.

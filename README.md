# herdr-toolkit

Personal customizations for the [Herdr](https://herdr.dev) desktop app.

## What's here

| Path | Installs to | What it does |
|---|---|---|
| `mods/claude-limits-status/` | `~/.config/herdr-app/mods/claude-limits-status/` | Herdr's bottom status bar (clone of `workspace-status` 0.1.16) plus Claude Code's model, usage limits and context window usage next to the agents count: `6 agents │ Opus 5.5 (medium) 17%/5h 3h35m 7%/7d 2d13h 42%/ctx`. Only the percentages are colored (green, yellow ≥ 60 %, red ≥ 85 %). Next to the branch it shows git stats for the focused terminal's folder, zero counts hidden: `⚔` conflicts, `●` staged, `✚` modified, `?` untracked, `↑`/`↓` ahead/behind upstream, `+A/−D` uncommitted lines, `stash N`, `REBASING`/`MERGING` (refreshed on focus change and every 6 s). Then the branch's pull request via `gh pr view`: `#123` (click opens it), CI `✓` pass / `✗` fail / `●` pending with its wall-clock time (earliest check start to latest finish; while running, time so far, refreshed every 10 s), `draft`/`merged`/`closed`, `approved`/`changes requested`; asked at most once a minute per branch, hidden when the branch has no PR or `gh` is missing. |
| `mods/vnh-chrome/` | `~/.config/herdr-app/mods/vnh-chrome/` | Clone of Herdr's `workspace-chrome` (0.1.16). The sidebar's top row is a JetBrains style run bar instead of the logo, search (`⌘P`) and sidebar toggle (`⌘B`): `📦 pnpm run dev ▾` and `▶`. It reads `package.json` scripts at the focused terminal's repo root only (the folder itself outside git); the package manager comes from `packageManager`, else the lock file, else npm. `▶` runs the selected script in a new tab at that folder; while it runs a red `■` stops it like JetBrains (SIGINT to its process group, SIGTERM after 3 s; the tab and output stay). A run records its pid in `~/.cache/vnh-run/`. The pill opens `vnh-run-menu` flush with its left edge. The choice is remembered per project; no `package.json` means an empty row. |
| `mods/vnh-run-menu/` | `~/.config/herdr-app/mods/vnh-run-menu/` | The run configurations popup: search, scripts A–Z with their commands, `↑`/`↓`, Enter or click selects, `▶` on a row runs it, Esc closes. |
| `mods/vnh-tabs/` | `~/.config/herdr-app/mods/vnh-tabs/` | Clone of Herdr's `tabs` (0.1.16) with a **Timeline** button after Files and Changes; it toggles the Timeline panel and is highlighted while the panel shows. Opening the Timeline (button, `⌘⇧B` or palette) closes the Files/Changes panel, and closing it reopens that panel if it was open; the left sidebar is left alone. |
| `mods/vnh-prompts/` | `~/.config/herdr-app/mods/vnh-prompts/` | Clone of the `over9k-prompts` Timeline panel without its "Timeline" title (the tab bar's button names it). `place` is `none` so Herdr does not dock an extra copy; the layout places it. |
| `mods/vnh-files/` | `~/.config/herdr-app/mods/vnh-files/` | Clone of Herdr's `files` (0.1.16) whose rows are drag sources: drag a file or folder into a terminal to type `@<path>` relative to the panel's folder (a folder ends in `/`), which Claude Code reads as a file mention. On a remote machine it stays the absolute path. Clicks still open folders and preview files. Header buttons (shown while the pointer is over the panel): sort (menu: name, type, modification time newest first; folders always first), show/hide git-ignored files (`git check-ignore`; shown dimmed when visible), show sizes (file bytes; a folder's first-level `N folders · M files`), expand all (breadth first, never into ignored folders, at most 200 folders), collapse all. Git status is shown as in VS Code: names colored and a letter on the right, `U` untracked / `A` added (green), `M` modified (yellow), `D` deleted / `!` conflict (red); folders take the most severe status inside them (icon and name colored, `•` on the right); ignored entries are dimmed. A previewed file with uncommitted changes gets a VS Code style overview ruler on the right (`git diff -U0 HEAD`; green added, blue modified, red removed; an untracked file is all green); clicking a mark puts the cursor on that line. The sort and the two toggles are remembered. The header's title is the folder's name instead of "Files"; a previewed file's path shows on the right. |
| `karabiner/herdr-hotkey.json` | merged into `~/.config/karabiner/karabiner.json` (selected profile) | Karabiner-Elements rule: `⌘`` ` from any app activates Herdr (`open -b dev.herdr.app`). It replaces macOS's own `⌘`` ` (cycle the windows of the front app). |
| `mods/vnh-worktree-sync/` | `~/.config/herdr-app/mods/vnh-worktree-sync/` | Opens every git worktree in a project's `.worktrees/` folder as a Herdr space (in the background), every 30 s, for the repos of the spaces already open. Herdr's sidebar nests them under their repo. Each worktree is opened once: one you close stays closed. Renders nothing; the VNH layout holds it in a 0 px sidebar block. |
| `mods/vnh-command/` | `~/.config/herdr-app/mods/vnh-command/` | `⌘↩` popup: type any command and Enter runs it in a new tab of the active space, at the focused terminal's repo root (else its folder), through `$SHELL -ic` (aliases, `&&`, pipes work). Empty input lists the history (newest first, with folder and age); typing filters it; `↑`/`↓`, Enter, `⌃D` forgets an entry, Esc. History: shared `vnh.cmd.history`, last 200, deduplicated. |
| `mods/vnh-markdown/` | `~/.config/herdr-app/mods/vnh-markdown/` | A rendered Markdown file in its own tab (`TextView.markdown`, selectable), opened by the eye button the Files panel shows while previewing a `.md`/`.markdown`/`.mdx` file. Re-reads the file every 2 s while the window is active; relative `.md` links open in another such tab, other links in the browser. |
| `claude/statusline.sh` | `~/.claude/statusline.sh` | Claude Code status line command. It publishes model, effort, 5h/7d usage, reset times and context % to `~/.cache/claude-statusline/limits.json` (read by the mod) and prints nothing, so the in-terminal status line is hidden. |
| `layouts/VNH.json` | `~/.config/herdr-app/layouts/VNH.json` | The **VNH** layout, based on Herdr's `main`: status bar uses `claude-limits-status`, the sidebar's top row uses `vnh-chrome`, the tab bar uses `vnh-tabs`, the Files panel uses `vnh-files`, and the sidebar footer (Settings / Add machine) is removed. Settings stays on `⌘,` and both are in the command palette (`⌘⇧P`). The Timeline panel (`vnh-prompts`) is the block `timeline`. |
| `keys/vnh.json` | merged into `~/.config/herdr-app/keys.json` | `⌘↩` (global) opens `vnh-command`. While the VNH layout shows: `⌘⇧B` toggles the Timeline panel through `vnh-tabs.timeline` (same as the tab bar's Timeline button, so Files/Changes closes and reopens in the same step) (next to Herdr's `⌘B` for the sidebar). |

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

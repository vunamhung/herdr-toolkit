#!/usr/bin/env bash
# Install the herdr-toolkit customizations. Existing files are backed up first: under the Herdr home to
# .backups/<timestamp>/<path>, elsewhere (~/.claude/statusline.sh, karabiner…) as <file>.bak-<timestamp>.
#
#   ./install.sh            mods + Claude Code status line script
#   ./install.sh --layout   also install layouts/VNH.json and switch Herdr to it
#   ./install.sh --karabiner  also add the Cmd+` -> Herdr rule to Karabiner-Elements
#   ./install.sh --orca     also install the Herdr theme "orca" (Claude Code's custom:orca palette) and set agy's
#                            colorScheme to terminal, so Claude, agy and Codex share one palette
#   ./install.sh --gestures  also build gestures/HerdrPinch.swift and run it as a LaunchAgent
#                            (trackpad pinch anywhere in Herdr: zoom in pulls, zoom out pushes)
# Options can be combined: ./install.sh --layout --karabiner --gestures --orca
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HERDR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# Backups of anything under the Herdr home go to $HERDR/.backups/<time>/<same path>, not beside the original:
# a copy of a mod folder left in mods/ would be listed (and could be loaded) as another mod.
backup() {
  [ -e "$1" ] || return 0
  case "$1" in
    "$HERDR"/*) dest="$HERDR/.backups/$STAMP/${1#"$HERDR"/}" ;;
    *) dest="$1.bak-$STAMP" ;;
  esac
  mkdir -p "$(dirname "$dest")" && cp -R "$1" "$dest" && echo "  backup: $dest"
  return 0
}

for mod in claude-limits-status vnh-chrome vnh-tabs vnh-prompts vnh-files vnh-worktree-sync vnh-git-menu vnh-command vnh-markdown vnh-pane vnh-files-menu vnh-weather vnh-spaces vnh-sessions vnh-agents vnh-filetree; do
  echo "mod: $mod"
  backup "$HERDR/mods/$mod"
  mkdir -p "$HERDR/mods/$mod"
  cp -R "$ROOT/mods/$mod/." "$HERDR/mods/$mod/"
done

# Overlays: files that live inside third-party mods or Herdr's own app frame, re-applied here because
# a mod or Herdr update overwrites them. walkthrough/: Vietnamese (default) + the dropdown anchored to
# its select box. frame/settings/: the read-only "Mods" tab. Re-run install after such an update.
if [ -d "$ROOT/overlays" ]; then
  echo "overlays: walkthrough i18n + Settings Mods tab"
  ( cd "$ROOT/overlays" && find . -type f ) | sed 's#^\./##' | while IFS= read -r rel; do
    # An overlay changes a mod or a frame that is already there (mods/walkthrough, frame/settings): on a
    # machine without it, copying the few changed files would leave a half mod behind.
    top=$(echo "$rel" | cut -d/ -f1-2)
    if [ ! -d "$HERDR/$top" ]; then echo "  skipped $rel ($HERDR/$top isn't installed: install it, then run this again)"; continue; fi
    echo "  $rel"
    backup "$HERDR/$rel"
    mkdir -p "$(dirname "$HERDR/$rel")"
    cp "$ROOT/overlays/$rel" "$HERDR/$rel"
  done
fi

echo "claude: ~/.claude/statusline.sh"
mkdir -p "$HOME/.claude"
backup "$HOME/.claude/statusline.sh"
cp "$ROOT/claude/statusline.sh" "$HOME/.claude/statusline.sh"
chmod +x "$HOME/.claude/statusline.sh"
# The status bar's other agents: the shared writer, plus the hook that calls it in agy and in Codex.
sh "$ROOT/status/install.sh" || echo "  note: status/install.sh failed, the status bar will only show Claude Code"
if ! jq -e '.statusLine.command == "~/.claude/statusline.sh"' "$HOME/.claude/settings.json" >/dev/null 2>&1; then
  echo "  note: set statusLine in ~/.claude/settings.json to:"
  echo '    "statusLine": { "type": "command", "command": "~/.claude/statusline.sh", "padding": 0 }'
fi

ARGS=" $* "
want() { case "$ARGS" in *" $1 "*) return 0;; esac; return 1; }

if want --layout; then
  echo "layout: VNH"
  backup "$HERDR/layouts/VNH.json"
  cp "$ROOT/layouts/VNH.json" "$HERDR/layouts/VNH.json"
  echo "keys: merge keys/vnh.json into keys.json"
  backup "$HERDR/keys.json"
  KEYS="$HERDR/keys.json"; [ -s "$KEYS" ] || echo "{}" > "$KEYS"
  jq -s '.[0] * .[1]' "$KEYS" "$ROOT/keys/vnh.json" > "$KEYS.tmp" && mv "$KEYS.tmp" "$KEYS"
  command -v herdr-app >/dev/null && herdr-app do layout.switch '{"name":"VNH"}' >/dev/null || true
fi

if want --orca; then
  sh "$ROOT/themes/install.sh"
fi

if want --karabiner; then
  echo "karabiner: Cmd+\` activates Herdr"
  KB="$HOME/.config/karabiner/karabiner.json"
  if [ ! -f "$KB" ]; then
    echo "  skipped: $KB not found (install Karabiner-Elements and open it once)"
  else
    backup "$KB"
    # Replace a rule with the same description in the selected profile, else prepend it.
    jq --slurpfile src "$ROOT/karabiner/herdr-hotkey.json" '
      ($src[0].rules) as $new | ($new | map(.description)) as $names
      | .profiles |= map(if .selected then
          .complex_modifications.rules = ($new + ((.complex_modifications.rules // []) | map(select(.description as $d | $names | index($d) | not))))
        else . end)' "$KB" > "$KB.tmp" && mv "$KB.tmp" "$KB"
  fi
fi

if want --gestures; then
  echo "gestures: trackpad pinch in Herdr pulls / pushes"
  # A small app (HerdrPinch.app, signed ad hoc): macOS keeps Accessibility for it more reliably than
  # for a bare linker-signed binary. Grant it once in System Settings > Privacy & Security >
  # Accessibility; a rebuild asks again.
  APP="$HOME/Applications/HerdrPinch.app"
  mkdir -p "$APP/Contents/MacOS" "$HOME/Library/LaunchAgents"
  swiftc -O -o "$APP/Contents/MacOS/herdr-pinch" "$ROOT/gestures/HerdrPinch.swift"
  cp "$ROOT/gestures/Info.plist" "$APP/Contents/Info.plist"
  codesign -f -s - --identifier dev.vnh.herdr-pinch "$APP"
  PL="$HOME/Library/LaunchAgents/dev.vnh.herdr-pinch.plist"
  [ -f "$PL" ] && { launchctl bootout "gui/$(id -u)" "$PL" 2>/dev/null; backup "$PL"; }
  sed "s#HOME_DIR#$HOME#g" "$ROOT/gestures/dev.vnh.herdr-pinch.plist" > "$PL"
  launchctl bootstrap "gui/$(id -u)" "$PL"
fi

if command -v herdr-app >/dev/null; then
  for mod in claude-limits-status vnh-chrome vnh-tabs vnh-prompts vnh-files vnh-worktree-sync vnh-git-menu vnh-command vnh-markdown vnh-pane vnh-files-menu vnh-weather vnh-spaces vnh-sessions vnh-agents vnh-filetree; do herdr-app check "$HERDR/mods/$mod"; done
fi
echo "done"

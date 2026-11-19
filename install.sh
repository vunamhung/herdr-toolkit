#!/usr/bin/env bash
# Install the herdr-toolkit customizations. Existing files are backed up as <file>.bak-<timestamp>.
#
#   ./install.sh            mods + Claude Code status line script
#   ./install.sh --layout   also install layouts/VNH.json and switch Herdr to it
#   ./install.sh --karabiner  also add the Cmd+` -> Herdr rule to Karabiner-Elements
# Options can be combined: ./install.sh --layout --karabiner
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HERDR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
STAMP="$(date +%Y%m%d-%H%M%S)"

backup() { [ -e "$1" ] && cp -R "$1" "$1.bak-$STAMP" && echo "  backup: $1.bak-$STAMP"; return 0; }

for mod in claude-limits-status vnh-chrome vnh-tabs vnh-prompts vnh-files vnh-worktree-sync vnh-run-menu vnh-command vnh-markdown vnh-pane vnh-files-menu vnh-weather vnh-spaces; do
  echo "mod: $mod"
  backup "$HERDR/mods/$mod"
  mkdir -p "$HERDR/mods/$mod"
  cp -R "$ROOT/mods/$mod/." "$HERDR/mods/$mod/"
done

echo "claude: ~/.claude/statusline.sh"
mkdir -p "$HOME/.claude"
backup "$HOME/.claude/statusline.sh"
cp "$ROOT/claude/statusline.sh" "$HOME/.claude/statusline.sh"
chmod +x "$HOME/.claude/statusline.sh"
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

if command -v herdr-app >/dev/null; then
  for mod in claude-limits-status vnh-chrome vnh-tabs vnh-prompts vnh-files vnh-worktree-sync vnh-run-menu vnh-command vnh-markdown vnh-pane vnh-files-menu vnh-weather vnh-spaces; do herdr-app check "$HERDR/mods/$mod"; done
fi
echo "done"

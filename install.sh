#!/usr/bin/env bash
# Install the herdr-toolkit customizations. Existing files are backed up as <file>.bak-<timestamp>.
#
#   ./install.sh            mods + Claude Code status line script
#   ./install.sh --layout   also install layouts/VNH.json and switch Herdr to it
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HERDR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
STAMP="$(date +%Y%m%d-%H%M%S)"

backup() { [ -e "$1" ] && cp -R "$1" "$1.bak-$STAMP" && echo "  backup: $1.bak-$STAMP"; return 0; }

for mod in claude-limits-status vnh-chrome vnh-tabs vnh-prompts vnh-files; do
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

if [ "${1:-}" = "--layout" ]; then
  echo "layout: VNH"
  backup "$HERDR/layouts/VNH.json"
  cp "$ROOT/layouts/VNH.json" "$HERDR/layouts/VNH.json"
  echo "keys: merge keys/vnh.json into keys.json"
  backup "$HERDR/keys.json"
  KEYS="$HERDR/keys.json"; [ -s "$KEYS" ] || echo "{}" > "$KEYS"
  jq -s '.[0] * .[1]' "$KEYS" "$ROOT/keys/vnh.json" > "$KEYS.tmp" && mv "$KEYS.tmp" "$KEYS"
  command -v herdr-app >/dev/null && herdr-app do layout.switch '{"name":"VNH"}' >/dev/null || true
fi

if command -v herdr-app >/dev/null; then
  for mod in claude-limits-status vnh-chrome vnh-tabs vnh-prompts vnh-files; do herdr-app check "$HERDR/mods/$mod"; done
fi
echo "done"

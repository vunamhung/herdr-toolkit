#!/usr/bin/env bash
# Install the herdr-toolkit customizations. Existing files are backed up as <file>.bak-<timestamp>.
#
#   ./install.sh            mod + Claude Code status line script
#   ./install.sh --layout   also install layouts/VNH.json and switch Herdr to it
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HERDR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
STAMP="$(date +%Y%m%d-%H%M%S)"

backup() { [ -e "$1" ] && cp -R "$1" "$1.bak-$STAMP" && echo "  backup: $1.bak-$STAMP"; return 0; }

echo "mod: claude-limits-status"
mkdir -p "$HERDR/mods/claude-limits-status"
for f in main.js mod.json; do
  backup "$HERDR/mods/claude-limits-status/$f"
  cp "$ROOT/mods/claude-limits-status/$f" "$HERDR/mods/claude-limits-status/$f"
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
  command -v herdr-app >/dev/null && herdr-app do layout.switch '{"name":"VNH"}' >/dev/null || true
fi

command -v herdr-app >/dev/null && herdr-app check "$HERDR/mods/claude-limits-status"
echo "done"

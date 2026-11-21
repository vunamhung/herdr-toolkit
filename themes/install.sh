#!/bin/sh
# Installs the Herdr theme "orca" and points agy at the terminal's colors, so Claude Code (custom:orca),
# agy, Codex and the shell share one palette. Pick "orca" in Herdr's Settings > Look afterwards.
#
# orca.json is the palette of Claude Code's custom:orca theme (~/.claude/themes/orca.json): the ansi row
# is its claude / success / error / warning / merged / suggestion colors, the background its inverseText,
# the selection its selectionBg. Claude Code paints truecolor from that file; agy has no custom themes (its
# colorScheme is one of eight built-in names), but its "terminal" scheme uses the terminal's own ansi
# colors, which this theme sets.
# Backs up agy's settings.json first; safe to run again.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLKIT_ROOT="$ROOT"; . "$ROOT/lib/jq.sh"
HERDR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$HERDR/themes"
cp "$ROOT/themes/orca.json" "$HERDR/themes/orca.json"
echo "theme: $HERDR/themes/orca.json (pick it in Settings > Look)"

AGY="$HOME/.gemini/antigravity-cli/settings.json"
if [ -f "$AGY" ]; then
  cur=$(jq -r '.colorScheme // empty' "$AGY")
  if [ "$cur" = "terminal" ]; then
    echo "agy: colorScheme is already terminal"
  else
    cp "$AGY" "$AGY.bak-$STAMP" && echo "  backup: $AGY.bak-$STAMP"
    jq '.colorScheme = "terminal"' "$AGY" > "$AGY.tmp.$$" && mv -f "$AGY.tmp.$$" "$AGY"
    echo "agy: colorScheme ${cur:-unset} -> terminal"
  fi
else
  echo "agy: skipped ($AGY not found)"
fi

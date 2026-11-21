#!/bin/sh
# Installs what the Herdr status bar needs from each agent: the shared writer plus the hook that calls it
# in Antigravity (agy) and Codex. Claude's side (~/.claude/statusline.sh) is installed by ../install.sh.
# Safe to run again. Every file it changes is backed up as <file>.bak-<timestamp> first, and an agent that
# already has its own status line / a differently configured hook is left alone and reported.
set -eu
ROOT="$(cd "$(dirname "$0")" && pwd)"
HERDR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
STAMP="$(date +%Y%m%d-%H%M%S)"
command -v jq >/dev/null 2>&1 || { echo "status: jq is required (brew install jq)"; exit 1; }

echo "status: $HERDR/status"
mkdir -p "$HERDR/status"
cp "$ROOT/write.sh" "$ROOT/agy.sh" "$ROOT/codex.sh" "$HERDR/status/"
chmod +x "$HERDR/status/"*.sh

backup() { [ -e "$1" ] && cp "$1" "$1.bak-$STAMP" && echo "  backup: $1.bak-$STAMP"; return 0; }
edit() { # edit <file> <jq filter> [jq args...]: rewrite the file through jq, atomically
  f="$1"; shift; filter="$1"; shift
  tmp="$f.tmp.$$"
  jq "$@" "$filter" "$f" > "$tmp" && mv -f "$tmp" "$f" || { rm -f "$tmp"; return 1; }
}

# Antigravity CLI: settings.json statusLine. stack_with_default keeps agy's own status line; ours prints nothing.
AGY="$HOME/.gemini/antigravity-cli/settings.json"
if [ -f "$AGY" ]; then
  cur=$(jq -r '.statusLine.command // empty' "$AGY")
  case "$cur" in
    ""|*status/agy.sh*)
      echo "agy: $AGY statusLine"
      backup "$AGY"
      edit "$AGY" '.statusLine = {type: "command", command: ("sh " + $cmd), stack_with_default: true}' --arg cmd "$HERDR/status/agy.sh"
      ;;
    *) echo "agy: skipped, it already has its own statusLine ($cur): call $HERDR/status/agy.sh from it" ;;
  esac
else
  echo "agy: skipped ($AGY not found: install agy and run it once)"
fi

# Codex: hooks.json (same shape as Claude's). A hook Codex hasn't seen is held until you trust it.
CODEX="$HOME/.codex"
if [ -d "$CODEX" ]; then
  [ -s "$CODEX/hooks.json" ] || echo '{"hooks": {}}' > "$CODEX/hooks.json"
  echo "codex: $CODEX/hooks.json (SessionStart, UserPromptSubmit, Stop)"
  backup "$CODEX/hooks.json"
  edit "$CODEX/hooks.json" '
    .hooks //= {}
    | reduce ("SessionStart", "UserPromptSubmit", "Stop") as $e (.;
        .hooks[$e] = ((.hooks[$e] // []) as $g
          | if any($g[]?; any(.hooks[]?; (.command // "") | contains("status/codex.sh"))) then $g
            else $g + [{hooks: [{type: "command", command: ("sh \"" + $cmd + "\""), timeout: 10}]}] end))' \
    --arg cmd "$HERDR/status/codex.sh"
  echo "  Codex holds a new hook until you trust it: open Codex, run /hooks and trust the Herdr status hook (once)."
else
  echo "codex: skipped ($CODEX not found)"
fi

#!/bin/sh
# Writes what the Herdr status bar shows for the agent running in THIS terminal:
#   ~/.cache/herdr-status/<terminal>.json  (HC_TERMINAL_ID is set for everything in a Herdr terminal)
#
#   write.sh <provider> <model> <effort> <ctx> <five> <five_reset> <seven> <seven_reset>
#
# provider: claude | codex | agy.  model: the name as the agent shows it.  effort: "" when none.
# ctx / five / seven: percent USED (0-100).  *_reset: unix seconds.  Any argument may be "".
# Limits that arrive late (Claude only reports them after the first answer) keep their previous
# value from the same terminal's file; model, effort and ctx always replace it. Only these fields
# are stored: nothing else from an agent's payload (accounts, e-mail, prompts) is written.
# Files of terminals idle for 2 days are dropped. Never fails: an agent must not be slowed or
# broken by its status bar.
[ -n "${HC_TERMINAL_ID:-}" ] || exit 0
case "$HC_TERMINAL_ID" in *[!A-Za-z0-9_-]*) exit 0 ;; esac
command -v jq >/dev/null 2>&1 || exit 0
DIR="$HOME/.cache/herdr-status"
mkdir -p "$DIR" 2>/dev/null || exit 0
FILE="$DIR/$HC_TERMINAL_ID.json"
prev=$(cat "$FILE" 2>/dev/null); [ -n "$prev" ] || prev='{}'
tmp=$(mktemp "$DIR/.write.XXXXXX") || exit 0
jq -n --argjson prev "$prev" --arg provider "$1" --arg model "$2" --arg effort "$3" --arg ctx "$4" \
  --arg five "$5" --arg five_reset "$6" --arg seven "$7" --arg seven_reset "$8" '
  def num: if . == "" then null else tonumber? end;
  def keep($k; $new): if $new != null then $new elif $prev.provider == $provider then $prev[$k] else null end;
  {
    provider: $provider,
    model: (if $model == "" then null else $model end),
    effort: (if $effort == "" then null else $effort end),
    ctx: ($ctx | num),
    five: keep("five"; ($five | num)),
    five_reset: keep("five_reset"; ($five_reset | num)),
    seven: keep("seven"; ($seven | num)),
    seven_reset: keep("seven_reset"; ($seven_reset | num)),
    updated: (now | floor)
  }' > "$tmp" 2>/dev/null && mv -f "$tmp" "$FILE" || rm -f "$tmp"
find "$DIR" -maxdepth 1 -name 't*.json' -mtime +2 -delete 2>/dev/null
exit 0

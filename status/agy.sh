#!/bin/sh
# Antigravity CLI (agy) status line command (installed as status/agy.sh): publishes model, effort, context and quota for the Herdr
# status bar and prints nothing (agy's own status line stays, see stack_with_default in install.sh).
#
# agy runs this command with a JSON payload on stdin. What is used:
#   model.display_name   "Gemini 3.8 Flash (High)"      (already carries the effort for Gemini models)
#   model.effort         "high"
#   context_window.used_percentage
#   quota["gemini-5h" | "gemini-weekly" | "3p-5h" | "3p-weekly"]  { remaining_fraction, reset_time }
# Gemini models draw on the gemini-* buckets, the third-party ones (Claude, GPT-OSS) on 3p-*.
# Plain sh on purpose: agy runs the command through `sh`, which has no process substitution.
# Fields are joined with | (a tab would swallow empty fields: it is IFS whitespace).
# The payload also holds the account's e-mail and plan: none of it is read or stored.
input=$(cat)
# jq: the copy the toolkit installs beside these scripts (status/bin), else the one on PATH. A status script
# must never fail an agent for want of jq, so without any it quietly does nothing.
JQ="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/status/bin/jq"
[ -x "$JQ" ] || JQ="$JQ.exe"
[ -x "$JQ" ] || JQ=$(command -v jq 2>/dev/null) || exit 0
jq() { "$JQ" "$@"; }
line=$(printf '%s' "$input" | jq -r '
  def n: if . == null then "" else tostring end;
  def used: if . == null then "" else ((1 - .) * 100 | round | tostring) end;
  def epoch: if . == null then "" else (sub("\\.[0-9]+";"") | sub("Z$";"") | strptime("%Y-%m-%dT%H:%M:%S") | mktime | tostring) end;
  (.model.display_name // .model.id // "") as $name
  | (if ($name | ascii_downcase | startswith("gemini")) then "gemini" else "3p" end) as $g
  | (.quota[$g + "-5h"]) as $q5 | (.quota[$g + "-weekly"]) as $q7
  | [ $name,
      (.model.effort | n),
      (.context_window.used_percentage | if . == null then "" else round | tostring end),
      ($q5.remaining_fraction | used), ($q5.reset_time | epoch),
      ($q7.remaining_fraction | used), ($q7.reset_time | epoch)
    ] | join("|")' 2>/dev/null)
IFS='|' read -r model effort ctx five five_reset seven seven_reset <<EOF
$line
EOF
# Its subagents (the payload lists each with a name, a role (its prompt) and a status): a short label for each, from the first
# bold phrase of the role, else its first line, so the Agents list can show them under the session. The prompts themselves aren't kept.
subs=$(printf '%s' "$input" | jq -c '[(.subagents // [])[] | {name: (.name // "agent"), status: (.status // ""), label: ((.role // "") as $r
  | ([$r | match("\\*\\*([^*\\n]{3,200})\\*\\*"; "g") | .captures[0].string] | first) // ($r | split("\n") | map(select(length > 0)) | first // "")
  | sub("^You are (an? )?"; "") | sub(" \\(.*$"; "") | .[0:70])}]' 2>/dev/null)
[ -n "$subs" ] || subs=null
# agy sets no terminal title (Herdr would show its command line), so the conversation's first prompt, from agy's
# own history file, goes with the other fields as the title the tab and the agents list show.
title=""
cid=$(printf '%s' "$input" | jq -r '.conversation_id // empty' 2>/dev/null)
if [ -n "$cid" ]; then
  title=$(grep -m 1 -F "\"conversationId\":\"$cid\"" "$HOME/.gemini/antigravity-cli/history.jsonl" 2>/dev/null | jq -r '.display // empty' 2>/dev/null | head -n 1 | cut -c1-80)
fi
sh "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/status/write.sh" agy "$model" "$effort" "$ctx" "$five" "$five_reset" "$seven" "$seven_reset" "$title" "$cid" "$subs" 2>/dev/null
exit 0

#!/bin/sh
# Antigravity CLI (agy) status line command (optimized single-jq execution):
# Publishes model, effort, context, quota, title, and subagents directly to
# ~/.cache/herdr-status/<HC_TERMINAL_ID>.json in a single jq invocation so
# agy's statusline runner never hits its process timeout under heavy load.
[ -n "${HC_TERMINAL_ID:-}" ] || exit 0
case "$HC_TERMINAL_ID" in *[!A-Za-z0-9_-]*) exit 0 ;; esac

JQ="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/status/bin/jq"
[ -x "$JQ" ] || JQ="$JQ.exe"
[ -x "$JQ" ] || JQ=$(command -v jq 2>/dev/null) || exit 0

DIR="$HOME/.cache/herdr-status"
[ -d "$DIR" ] || mkdir -p "$DIR" 2>/dev/null || exit 0
FILE="$DIR/$HC_TERMINAL_ID.json"
HIST="$HOME/.gemini/antigravity-cli/history.jsonl"

prev='{}'
[ -r "$FILE" ] && { prev=$(cat "$FILE" 2>/dev/null); [ -n "$prev" ] || prev='{}'; }

input=$(cat)
tmp="$DIR/.agy.$$.tmp"
# Only load history.jsonl when prev has no cached title for the current conversation_id (avoids reading multi-MB history on every tick).
need_hist=1
case "$prev" in
  *'"provider":"agy"'*)
    prev_cid=$(printf '%s' "$prev" | sed -n 's/.*"session":"\([^"]*\)".*/\1/p')
    cur_cid=$(printf '%s' "$input" | sed -n 's/.*"conversation_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    case "$prev" in
      *'"title":null'*|*'"title":""'*) ;;
      *'"title":"'*) [ -n "$cur_cid" ] && [ "$prev_cid" = "$cur_cid" ] && need_hist=0 ;;
    esac
    ;;
esac
if [ "$need_hist" -eq 1 ] && [ -r "$HIST" ]; then
  set -- --rawfile hist "$HIST"
else
  set -- --arg hist ""
fi

printf '%s' "$input" | "$JQ" -c --argjson prev "$prev" "$@" '
  def used: if . == null then null else ((1 - .) * 100 | round) end;
  def epoch: if . == null then null else (try (sub("\\.[0-9]+";"") | sub("Z$";"") | strptime("%Y-%m-%dT%H:%M:%S") | mktime) catch null) end;
  def keep($k; $new): if $new != null then $new elif $prev.provider == "agy" then $prev[$k] else null end;
  (.model.display_name // .model.id // "") as $raw_model
  | (if $raw_model == "" then null else $raw_model end) as $model
  | (.model.effort // "") as $raw_effort
  | (if $raw_effort == "" then null else ($raw_effort | tostring) end) as $effort
  | (if ($raw_model | ascii_downcase | startswith("gemini")) then "gemini" else "3p" end) as $g
  | (.quota[$g + "-5h"]) as $q5
  | (.quota[$g + "-weekly"]) as $q7
  | (.conversation_id // "") as $cid
  | (if $cid != "" then $cid elif $prev.provider == "agy" then $prev.session else null end) as $session
  | (
      if ($prev.provider == "agy" and $prev.session == $cid and ($prev.title // "") != "") then $prev.title
      elif ($cid != "" and $hist != "") then
        ($hist | split("\n")
          | map(select(contains("\"conversationId\":\"" + $cid + "\"")))
          | first // ""
          | (try fromjson catch {}) | .display // "" | .[0:80]
          | if . == "" then null else . end)
      elif $prev.provider == "agy" then $prev.title
      else null end
    ) as $title
  | [(.subagents // [])[] | {
      name: (.name // "agent"),
      status: (.status // ""),
      label: ((.role // "") as $r
        | ([$r | match("\\*\\*([^*\\n]{3,200})\\*\\*"; "g") | .captures[0].string] | first)
          // ($r | split("\n") | map(select(length > 0)) | first // "")
        | sub("^You are (an? )?"; "") | sub(" \\(.*$"; "") | .[0:70])
    }] as $subs
  | {
      provider: "agy",
      model: $model,
      effort: $effort,
      title: $title,
      subagents: $subs,
      session: $session,
      ctx: (.context_window.used_percentage | if . == null then null else round end),
      five: keep("five"; ($q5.remaining_fraction | used)),
      five_reset: keep("five_reset"; ($q5.reset_time | epoch)),
      seven: keep("seven"; ($q7.remaining_fraction | used)),
      seven_reset: keep("seven_reset"; ($q7.reset_time | epoch)),
      updated: (now | floor)
    }
' > "$tmp" 2>/dev/null && [ -s "$tmp" ] && mv -f "$tmp" "$FILE" || rm -f "$tmp"
exit 0

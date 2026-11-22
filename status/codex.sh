#!/bin/sh
# Codex lifecycle hook (SessionStart, UserPromptSubmit, Stop): publishes the model, effort, context and
# usage limits of the Codex session in this terminal for the Herdr status bar. Prints nothing.
#
# Codex gives a hook a JSON payload on stdin; used here:
#   model             the model slug ("gpt-5.6-terra"), shown by its display name from ~/.codex/models_cache.json
#   transcript_path   the session's rollout file (JSON lines), which holds the rest:
#     turn_context        payload.model, payload.effort          (the last turn's settings)
#     event_msg/token_count
#       payload.info.last_token_usage, payload.info.model_context_window   -> context used
#       payload.rate_limits.primary / .secondary { used_percent, window_minutes, resets_at }
#                                                                           -> 5h / 7d (by window length)
# Context used follows Codex's own "context left": the 12000 baseline tokens are free, and reasoning
# tokens don't count. Plain sh on purpose (hooks run through `sh`: no bash-only syntax). The rollout is read from its last 3 MB only. Never fails: exit 0 always.
input=$(cat)
[ -n "${HC_TERMINAL_ID:-}" ] || exit 0
# jq: the copy the toolkit installs beside these scripts (status/bin), else the one on PATH. A status script
# must never fail an agent for want of jq, so without any it quietly does nothing.
JQ="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/status/bin/jq"
[ -x "$JQ" ] || JQ="$JQ.exe"
[ -x "$JQ" ] || JQ=$(command -v jq 2>/dev/null) || exit 0
jq() { "$JQ" "$@"; }
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
slug=$(printf '%s' "$input" | jq -r '.model // empty' 2>/dev/null)
rollout=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)

line=""
if [ -n "$rollout" ] && [ -f "$rollout" ]; then
  line=$(tail -c 3000000 "$rollout" 2>/dev/null | jq -n -R -r '
    [inputs | fromjson? | select(type == "object")] as $ev
    | ([$ev[] | select(.type == "turn_context")] | last | .payload) as $tc
    | ([$ev[] | select(.type == "event_msg" and .payload.type == "token_count" and .payload.info != null)] | last | .payload.info) as $info
    | ([$ev[] | select(.type == "event_msg" and .payload.type == "token_count" and .payload.rate_limits != null)] | last | .payload.rate_limits) as $rl
    | def pct($u; $w): if $u == null or $w == null or $w <= 12000 then ""
        else (((($u.total_tokens // 0) - ($u.reasoning_output_tokens // 0)) - 12000) as $used
              | (($w - 12000) as $eff | (100 - ((([$eff - ([$used, 0] | max), 0] | max) / $eff * 100) | round)) | tostring)) end;
      def win($x): if $x == null then null else {used: ($x.used_percent), mins: ($x.window_minutes // 0),
          reset: ($x.resets_at // (if $x.resets_in_seconds != null then (now + $x.resets_in_seconds | floor) else null end))} end;
      ([win($rl.primary), win($rl.secondary)] | map(select(. != null))) as $w
    | ($w | map(select(.mins <= 2880)) | first) as $five
    | ($w | map(select(.mins > 2880)) | first) as $seven
    | [ ($tc.model // ""), ($tc.effort // ""), pct($info.last_token_usage; $info.model_context_window),
        ($five.used // "" | tostring | if . == "null" then "" else . end), ($five.reset // "" | tostring | if . == "null" then "" else . end),
        ($seven.used // "" | tostring | if . == "null" then "" else . end), ($seven.reset // "" | tostring | if . == "null" then "" else . end)
      ] | join("|")' 2>/dev/null)
fi
IFS='|' read -r tc_model effort ctx five five_reset seven seven_reset <<EOF
$line
EOF
[ -n "$tc_model" ] && slug="$tc_model"
[ -n "$slug" ] || exit 0

# Display name and the model's default effort from Codex's own model list; the slug if it isn't there.
names=$(jq -r --arg s "$slug" '
  ([.models[]? | select(.slug == $s)] | first) as $m | [($m.display_name // $s), ($m.default_reasoning_level // "")] | join("|")' \
  "$CODEX_HOME/models_cache.json" 2>/dev/null)
IFS='|' read -r name default_effort <<EOF
$names
EOF
[ -n "$name" ] || name="$slug"
# No effort in the rollout yet (a session that hasn't taken a turn): config.toml's, else the model's default.
if [ -z "$effort" ]; then
  effort=$(sed -n 's/^model_reasoning_effort[[:space:]]*=[[:space:]]*"\{0,1\}\([A-Za-z]*\)"\{0,1\}.*/\1/p' "$CODEX_HOME/config.toml" 2>/dev/null | head -1)
  [ -n "$effort" ] || effort="$default_effort"
fi
sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
sh "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/status/write.sh" codex "$name" "$effort" "$ctx" "$five" "$five_reset" "$seven" "$seven_reset" "" "$sid" 2>/dev/null
exit 0

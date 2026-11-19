#!/bin/bash
# Claude Code status line (2 lines)
# L1 (where you are): model (effort) | dir  branch git-state  diff  stash  PR/CI | output style | clock
# L2 (how it's going): 5h limit | 7d limit | time | cost | lines | ctx | cache | out tok
input=$(cat)

# Keep Orca's usage tracking working (it reads the same payload, prints nothing)
ORCA_SL="$HOME/.orca/agent-hooks/claude-statusline.sh"
if [ -x "$ORCA_SL" ] && [ -n "${ORCA_PANE_KEY-}${ORCA_AGENT_PANE-}" ]; then
  (printf '%s' "$input" | /bin/sh "$ORCA_SL" >/dev/null 2>&1 &)
fi

DATA="$HOME/.cache/claude-statusline"; mkdir -p "$DATA" 2>/dev/null

# ---------- parse payload (one jq call, "-" = missing) ----------
IFS=$'\t' read -r model effort dur_ms api_ms cost added removed ctx five five_reset seven \
  cwd style cache out_tok vim agent sid big seven_reset cache_exp fast < <(printf '%s' "$input" | jq -r '
  def n: if . == null or . == "" then "-" else tostring end;
  def fl: if . == null then "-" else floor | tostring end;
  def epoch: if . == null then "-" elif type == "number" then (if . > 1e12 then ./1000 else . end | floor | tostring)
             else (sub("\\.[0-9]+";"") | sub("Z$";"") | strptime("%Y-%m-%dT%H:%M:%S") | mktime | tostring) end;
  [ (.model.display_name // .model.id // "?"),
    (.effort.level // .model.effort // .reasoning_effort | n),
    (.cost.total_duration_ms // 0 | floor | tostring),
    (.cost.total_api_duration_ms // 0 | floor | tostring),
    (.cost.total_cost_usd | n),
    (.cost.total_lines_added // 0 | tostring),
    (.cost.total_lines_removed // 0 | tostring),
    (.context_window.used_percentage | fl),
    (.rate_limits.five_hour.used_percentage | fl),
    (.rate_limits.five_hour.resets_at | epoch),
    (.rate_limits.seven_day.used_percentage | fl),
    (.workspace.current_dir // .cwd | n),
    (.output_style.name | n),
    (if .prompt_cache.hit_ratio != null then (.prompt_cache.hit_ratio * 100 | floor | tostring)
     else .context_window.current_usage as $u | if $u == null then "-" else
       (($u.input_tokens // 0) + ($u.cache_creation_input_tokens // 0) + ($u.cache_read_input_tokens // 0)) as $t
       | if $t > 0 then (($u.cache_read_input_tokens // 0) * 100 / $t | floor | tostring) else "-" end end end),
    (.context_window.total_output_tokens | n),
    (.vim.mode | n),
    (.agent.name | n),
    (.session_id | n),
    (.exceeds_200k_tokens // false | tostring),
    (.rate_limits.seven_day.resets_at | epoch),
    (.prompt_cache.expires_at | epoch),
    (.fast_mode // false | tostring)
  ] | @tsv' 2>/dev/null)
for v in effort cost ctx five five_reset seven cwd style cache out_tok vim agent sid seven_reset cache_exp; do
  [ "${!v}" = "-" ] && eval "$v=''"
done
[ -z "$effort" ] && effort=$(jq -r '.effortLevel // empty' "$HOME/.claude/settings.json" 2>/dev/null)

# ---------- publish model + limits for the Herdr status bar ----------
# mods/claude-limits-status in ~/.config/herdr-app reads this file. Fields missing from this payload
# (rate limits arrive only after the first API response) keep their previous values.
LIMITS="$DATA/limits.json"
prev=$(cat "$LIMITS" 2>/dev/null); [ -z "$prev" ] && prev='{}'
tmp=$(mktemp "$DATA/limits.XXXXXX") && jq -n --argjson prev "$prev" \
  --arg model "$model" --arg effort "$effort" \
  --arg five "$five" --arg five_reset "$five_reset" --arg seven "$seven" --arg seven_reset "$seven_reset" '
  def num: if . == "" then null else tonumber end;
  $prev + {model: $model, effort: (if $effort == "" then null else $effort end), updated: now | floor}
  + ({five: ($five | num), five_reset: ($five_reset | num), seven: ($seven | num), seven_reset: ($seven_reset | num)}
     | with_entries(select(.value != null)))' > "$tmp" 2>/dev/null && mv -f "$tmp" "$LIMITS" || rm -f "$tmp"

# Status line moved to the Herdr status bar: print nothing here.
# To bring the in-terminal status line back, delete the next line.
exit 0

# ---------- helpers ----------
R=$'\033[0m'; DIM=$'\033[2m'; RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; CYN=$'\033[36m'; MAG=$'\033[35m'; BLU=$'\033[34m'
SEP=" ${DIM}|${R} "
fmt_dur() { local s=$1
  if   [ "$s" -lt 60 ];     then echo "${s}s"
  elif [ "$s" -lt 600 ];    then echo "$((s/60))m$(printf '%02d' $((s%60)))s"
  elif [ "$s" -lt 3600 ];   then echo "$((s/60))m"
  elif [ "$s" -lt 172800 ]; then echo "$((s/3600))h$(printf '%02d' $(((s%3600)/60)))m"
  else echo "$((s/86400))d$(( (s%86400)/3600 ))h"; fi; }
pct_color() { # $1 pct, $2 warn, $3 crit
  if [ "$1" -ge "$3" ]; then printf '%s' "$RED"; elif [ "$1" -ge "$2" ]; then printf '%s' "$YEL"; else printf '%s' "$GRN"; fi; }
bar() { local f=$(( ($1 * 10 + 50) / 100 )) i out=""
  [ $f -gt 10 ] && f=10
  for ((i=0;i<10;i++)); do if [ $i -lt $f ]; then out+="▰"; else out+="▱"; fi; done
  printf '%s' "$out"; }
kfmt() { if [ "$1" -ge 1000000 ]; then awk -v t="$1" 'BEGIN{printf "%.1fM", t/1e6}'
         elif [ "$1" -ge 1000 ]; then awk -v t="$1" 'BEGIN{printf "%.1fk", t/1e3}'; else echo "$1"; fi; }
mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }

now=$(date +%s)

# ==================== LINE 1: where you are ====================
l1=""
[ -n "$agent" ] && l1+="🤖 ${MAG}${agent}${R}${SEP}"
[ -n "$vim" ] && l1+="${YEL}[${vim}]${R} "
l1+="🧠 ${CYN}${model}${R}"
[ -n "$effort" ] && l1+=" ${DIM}(${effort})${R}"

if [ -n "$cwd" ]; then
  l1+="${SEP}📁 $(basename "$cwd")"
  # git info: cached per repo for 5s; stale cache is shown instantly while a background job refreshes it
  git_info() { # prints: branch<TAB>rendered segment   (empty if not a repo)
    local cwd=$1 g st staged modified untracked conflicts gi ab ahead behind da dd last age stash gd branch
    git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
    g() { git -C "$cwd" --no-optional-locks "$@" 2>/dev/null; }
    branch=$(g branch --show-current); [ -z "$branch" ] && branch="@$(g rev-parse --short HEAD)"
    st=$(g status --porcelain)
    staged=$(printf '%s\n' "$st" | grep -c '^[MADRC]')
    modified=$(printf '%s\n' "$st" | grep -c '^.[MD]')
    untracked=$(printf '%s\n' "$st" | grep -c '^??')
    conflicts=$(printf '%s\n' "$st" | grep -c '^\(UU\|AA\|DD\)')
    gi="🌿 ${MAG}${branch}${R}"
    [ "$conflicts" -gt 0 ] && gi+=" ${RED}⚔${conflicts} conflict${R}"
    [ "$staged" -gt 0 ]    && gi+=" ${GRN}●${staged}${R}"
    [ "$modified" -gt 0 ]  && gi+=" ${YEL}✚${modified}${R}"
    [ "$untracked" -gt 0 ] && gi+=" ${DIM}?${untracked}${R}"
    if ab=$(g rev-list --left-right --count '@{upstream}...HEAD'); then
      behind=${ab%%$'\t'*}; ahead=${ab##*$'\t'}
      [ "$ahead" -gt 0 ]  && gi+=" ↑${ahead}"
      [ "$behind" -gt 0 ] && gi+=" ${RED}↓${behind}${R}"
    fi
    if [ -n "$st" ]; then
      read -r da dd <<<"$(g diff HEAD --numstat | awk '{a+=$1; d+=$2} END{print a+0, d+0}')"
      [ $((da + dd)) -gt 0 ] && gi+=" ${DIM}Δ${R}${GRN}+${da}${R}${DIM}/${R}${RED}-${dd}${R}"
      last=$(g log -1 --format=%ct)
      if [ -n "$last" ]; then
        age=$(( $(date +%s) - last ))
        [ "$age" -ge 3600 ] && gi+=" ${YEL}⌛$(fmt_dur $age) uncommitted${R}"
      fi
    fi
    stash=$(g stash list | wc -l | tr -d ' ')
    [ "$stash" -gt 0 ] && gi+=" ${DIM}📦${stash}${R}"
    gd=$(g rev-parse --absolute-git-dir)
    { [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ]; } && gi+=" ${RED}REBASING${R}"
    [ -f "$gd/MERGE_HEAD" ] && gi+=" ${RED}MERGING${R}"
    printf '%s\t%s' "$branch" "$gi"
  }
  gkey=$(printf '%s' "$cwd" | shasum | cut -c1-12)
  gf="$DATA/git-$gkey"
  if [ -f "$gf" ]; then
    gage=$((now - $(mtime "$gf")))
    # refresh if older than 5s, or if HEAD/index changed after the cache was written
    gdir="$cwd/.git"
    changed=0
    for f in "$gdir/HEAD" "$gdir/index"; do
      [ -f "$f" ] && [ "$(mtime "$f")" -gt "$(mtime "$gf")" ] && changed=1
    done
    if [ "$gage" -ge 5 ] || [ "$changed" = 1 ]; then
      lock="$gf.lock"
      if mkdir "$lock" 2>/dev/null; then
        ( git_info "$cwd" > "$gf.tmp.$$" && mv -f "$gf.tmp.$$" "$gf"; rmdir "$lock" ) >/dev/null 2>&1 &
      elif [ $((now - $(mtime "$lock"))) -gt 30 ]; then rmdir "$lock" 2>/dev/null
      fi
    fi
  else
    git_info "$cwd" > "$gf.tmp.$$" && mv -f "$gf.tmp.$$" "$gf"
  fi
  IFS=$'\t' read -r branch gi < "$gf" 2>/dev/null
  if [ -n "$branch" ]; then
    l1+=" ${gi}"

    # PR + CI status via gh, cached 60s and refreshed in background (never blocks)
    if command -v gh >/dev/null 2>&1 && [ "${branch#@}" = "$branch" ]; then
      key=$(printf '%s' "$cwd:$branch" | shasum | cut -c1-12)
      pf="$DATA/pr-$key"
      if [ ! -f "$pf" ] || [ $((now - $(mtime "$pf"))) -gt 60 ]; then
        touch "$pf"
        ( cd "$cwd" && gh pr view --json number,state,isDraft,reviewDecision,statusCheckRollup 2>/dev/null | jq -r '
            ([.statusCheckRollup[]? | (.conclusion // .state // .status | ascii_upcase)]) as $c
            | (if ($c|length)==0 then ""
               elif any($c[]; .=="FAILURE" or .=="ERROR" or .=="TIMED_OUT" or .=="CANCELLED") then "❌"
               elif any($c[]; .=="PENDING" or .=="IN_PROGRESS" or .=="QUEUED" or .=="EXPECTED" or .=="") then "⏳"
               else "✅" end) as $ci
            | (if .reviewDecision=="APPROVED" then "👍" elif .reviewDecision=="CHANGES_REQUESTED" then "✋" else "" end) as $rv
            | "#\(.number)\(if .isDraft then " draft" elif .state!="OPEN" then " "+(.state|ascii_downcase) else "" end) \($ci)\($rv)"' \
            > "$pf.tmp" 2>/dev/null; mv -f "$pf.tmp" "$pf" ) >/dev/null 2>&1 &
      fi
      pr=$(cat "$pf" 2>/dev/null)
      [ -n "$pr" ] && l1+="${SEP}🔀 ${BLU}${pr}${R}"
    fi
  fi
fi
[ -n "$style" ] && [ "$style" != "default" ] && l1+="${SEP}🗣️ ${style}"

# ==================== LINE 2: how it's going (compact) ====================
D=" ${DIM}│${R} "
l2=""
# --- limits first ---
if [ -n "$five" ]; then
  if [ "$five" -ge 80 ]; then bat="🪫"; else bat="🔋"; fi
  l2+="${bat} $(pct_color "$five" 60 85)${five}%${R}${DIM}/5h${R}"
  if [ -n "$five_reset" ] && [ $((five_reset - now)) -gt 0 ]; then
    left=$((five_reset - now))
    l2+=" ${DIM}⟳ $(fmt_dur $left)${R}"
    elapsed=$((18000 - left))
    if [ "$elapsed" -ge 1800 ] && [ "$five" -gt 0 ]; then
      proj=$((five * 18000 / elapsed))
      if [ "$proj" -ge 100 ]; then l2+=" ${RED}🔥 $(fmt_dur $(( (100 - five) * elapsed / five )))${R}"
      elif [ "$proj" -ge 80 ]; then l2+=" ${YEL}📈 ${proj}%${R}"; fi
    fi
  fi
fi
if [ -n "$seven" ]; then
  [ -n "$l2" ] && l2+="$D"
  l2+="📅 $(pct_color "$seven" 60 85)${seven}%${R}${DIM}/7d${R}"
  if [ -n "$seven_reset" ] && [ $((seven_reset - now)) -gt 0 ]; then
    l2+=" ${DIM}⟳ $(fmt_dur $((seven_reset - now)))${R}"
    # number of 5h windows that will still reset before the weekly limit resets
    if [ -n "$five_reset" ] && [ "$seven_reset" -gt "$five_reset" ]; then
      l2+=" ${CYN}♻ $(( (seven_reset - five_reset) / 18000 + 1 ))${R}"
    fi
  fi
fi

# --- session ---
s=$((dur_ms / 1000))
[ -n "$l2" ] && l2+="$D"
l2+="⏱ $(fmt_dur $s)"
[ "$dur_ms" -gt 0 ] && [ "$api_ms" -gt 0 ] && l2+=" ${DIM}🤖 $((api_ms * 100 / dur_ms))%${R}"

if [ -n "$cost" ]; then
  l2+="${D}💰 \$$(printf '%.2f' "$cost")"
  [ "$s" -ge 300 ] && l2+=" ${DIM}\$$(awk -v c="$cost" -v s="$s" 'BEGIN{printf "%.1f", c*3600/s}')/h${R}"
  if [ -n "$sid" ]; then
    df="$DATA/cost-$(date +%Y-%m-%d).json"
    [ -f "$df" ] || echo '{}' > "$df"
    if jq --arg k "$sid" --argjson v "$cost" '.[$k]=$v' "$df" > "$df.$$" 2>/dev/null; then mv -f "$df.$$" "$df"; else rm -f "$df.$$"; fi
    read -r today nsess <<<"$(jq -r '"\([.[]] | add // 0) \(length)"' "$df" 2>/dev/null)"
    [ "${nsess:-0}" -gt 1 ] && l2+=" ${DIM}Σ \$$(printf '%.1f' "$today")×${nsess}${R}"
    find "$DATA" -name 'cost-*.json' -mtime +30 -delete 2>/dev/null
  fi
fi

{ [ "$added" -gt 0 ] || [ "$removed" -gt 0 ]; } && l2+="${D}✏ ${GRN}+${added}${R}${RED}-${removed}${R}"

# --- context & cache ---
if [ -n "$ctx" ]; then
  col=$(pct_color "$ctx" 60 80)
  l2+="${D}📖 ${col}${ctx}%${R}"
  [ "$ctx" -ge 80 ] && l2+=" ${RED}/compact${R}"
fi
[ "$big" = "true" ] && l2+=" ${RED}⚠ 200k${R}"

if [ -n "$cache" ]; then
  l2+="${D}💾 $(pct_color $((100 - cache)) 30 60)${cache}%${R}"
  # time until the prompt cache goes cold (next message would re-pay full context)
  if [ -n "$cache_exp" ]; then
    cl=$((cache_exp - now))
    if [ "$cl" -gt 0 ]; then
      if [ "$cl" -lt 300 ]; then l2+=" ${YEL}❄ $(fmt_dur $cl)${R}"; else l2+=" ${DIM}❄ $(fmt_dur $cl)${R}"; fi
    else l2+=" ${RED}❄ cold${R}"; fi
  fi
fi
[ -n "$out_tok" ] && [ "$out_tok" -gt 0 ] && l2+="${D}📤 $(kfmt "$out_tok")"
[ "$fast" = "true" ] && l2+="${D}${YEL}⚡ fast${R}"

printf '%s\n%s' "$l1" "$l2"

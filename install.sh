#!/usr/bin/env bash
# Install the herdr-toolkit customizations. Existing files are backed up first: under the Herdr home to
# .backups/<timestamp>/<path>, elsewhere (~/.claude/statusline.sh, karabiner…) as <file>.bak-<timestamp>.
#
#   ./install.sh            mods + Claude Code status line script
#   ./install.sh --layout   also install layouts/VNH.json (and its picture) and switch Herdr to it
#   ./install.sh --karabiner  also add the Cmd+` -> Herdr rule to Karabiner-Elements
#   ./install.sh --orca     also install the Herdr theme "orca" (Claude Code's custom:orca palette) and set agy's
#                            colorScheme to terminal, so Claude, agy and Codex share one palette
#   ./install.sh --gestures  also build gestures/HerdrPad.m and PadActions.m and run them as LaunchAgents
#                            (HerdrPad, only in Herdr: pinch = git pull / push, sideways two-finger scroll = tab switcher;
#                            PadActions: four-finger swipes / tap = cmd-W, cmd-T, cmd-shift-T; edge slides = volume, brightness)
# Options can be combined: ./install.sh --layout --karabiner --gestures --orca
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TOOLKIT_ROOT="$ROOT"; . "$ROOT/lib/jq.sh"   # jq(): the build this repo ships, else PATH
HERDR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# Backups of anything under the Herdr home go to $HERDR/.backups/<time>/<same path>, not beside the original:
# a copy of a mod folder left in mods/ would be listed (and could be loaded) as another mod.
backup() {
  [ -e "$1" ] || return 0
  case "$1" in
    "$HERDR"/*) dest="$HERDR/.backups/$STAMP/${1#"$HERDR"/}" ;;
    *) dest="$1.bak-$STAMP" ;;
  esac
  mkdir -p "$(dirname "$dest")" && cp -R "$1" "$dest" && echo "  backup: $dest"
  return 0
}

# Our own mods, then the third-party ones this repo carries (each with its LICENSE; the ones we changed say so in
# their first lines), so one clone is the whole UI. herdr-chat (chat, new-chat, chat-menu, chat-agents and its
# host) is installed from vendor/herdr-chat below.
MODS="claude-limits-status vnh-chrome vnh-tabs vnh-tabswitch vnh-prompts vnh-convo vnh-worktree-sync vnh-git-menu vnh-command vnh-markdown vnh-pane vnh-weather vnh-spaces vnh-sessions vnh-agents vnh-cover vnh-changes-menu vnh-filetree vnh-scripts vnh-timeline file-icons better-changes cloudflare-deploys insights portal run walkthrough"
for mod in $MODS; do
  echo "mod: $mod"
  backup "$HERDR/mods/$mod"
  mkdir -p "$HERDR/mods/$mod"
  # Files an older version of this mod had and this one doesn't would stay behind: drop them, but keep what the
  # mod or you wrote there (config.json, runtime.json) and Herdr's generated typings.
  ( cd "$HERDR/mods/$mod" && find . -type f ! -name config.json ! -name runtime.json ! -name gpui-kit.d.ts ! -name jsconfig.json ! -name '*.error' ) |
    while IFS= read -r f; do [ -e "$ROOT/mods/$mod/$f" ] || { rm -f "$HERDR/mods/$mod/$f"; echo "  removed stale $f"; }; done
  # Copy tracked mod files only: never copy generated typings or overwrite an existing user config.json / runtime.json.
  ( cd "$ROOT/mods/$mod" && find . -type f ! -name gpui-kit.d.ts ! -name jsconfig.json ! -name '*.error' ! -name .DS_Store ) |
    while IFS= read -r f; do
      case "$f" in ./config.json|./runtime.json) [ -e "$HERDR/mods/$mod/$f" ] && continue ;; esac
      mkdir -p "$(dirname "$HERDR/mods/$mod/$f")"
      cp "$ROOT/mods/$mod/$f" "$HERDR/mods/$mod/$f"
    done
done

# Shared Python helpers used by multiple VNH mods (installed under $HERDR/lib).
if [ -f "$ROOT/lib/sessions.py" ]; then
  mkdir -p "$HERDR/lib"
  cp "$ROOT/lib/sessions.py" "$HERDR/lib/sessions.py"
  chmod +x "$HERDR/lib/sessions.py"
fi
# Backwards compatibility for existing Claude Code hooks that still reference mods/filetree/bridge.ts.
if [ -f "$ROOT/mods/vnh-filetree/bridge.ts" ] && { [ -d "$HERDR/mods/filetree" ] || grep -q 'mods/filetree/bridge\.ts' "$HOME/.claude/settings.json" 2>/dev/null; }; then
  mkdir -p "$HERDR/mods/filetree"
  cp "$ROOT/mods/vnh-filetree/bridge.ts" "$HERDR/mods/filetree/bridge.ts"
fi

# herdr-chat, from the release archive in vendor/ (checked against its SHA256SUMS): the host, the chat mods, the
# hc templates. Needs node 20+. Its installer wants the Herdr home to exist (start Herdr once).
if [ -f "$ROOT/vendor/herdr-chat/install.sh" ]; then
  echo "herdr-chat: vendor/herdr-chat"
  sh "$ROOT/vendor/herdr-chat/install.sh" --app --from "$ROOT/vendor/herdr-chat" --no-layout \
    || echo "  note: herdr-chat did not install (needs node 20+ and a Herdr home); the chat mods and Agents list stay as they are"
fi

# Overlays: files of herdr-chat's mods (made by its installer) and of Herdr's own app frame, which this repo
# cannot ship whole, re-applied here because an update overwrites them. chat/: publishes its model for the
# status bar. frame/settings/: the read-only "Mods" tab. Re-run install after such an update.
if [ -d "$ROOT/overlays" ]; then
  echo "overlays: chat, Settings Mods tab"
  ( cd "$ROOT/overlays" && find . -type f ) | sed 's#^\./##' | while IFS= read -r rel; do
    # An overlay changes a mod or a frame that is already there (mods/walkthrough, frame/settings): on a
    # machine without it, copying the few changed files would leave a half mod behind.
    top=$(echo "$rel" | cut -d/ -f1-2)
    if [ ! -d "$HERDR/$top" ]; then echo "  skipped $rel ($HERDR/$top isn't installed: install it, then run this again)"; continue; fi
    echo "  $rel"
    backup "$HERDR/$rel"
    mkdir -p "$(dirname "$HERDR/$rel")"
    cp "$ROOT/overlays/$rel" "$HERDR/$rel"
  done
fi

echo "claude: ~/.claude/statusline.sh"
mkdir -p "$HOME/.claude"
backup "$HOME/.claude/statusline.sh"
cp "$ROOT/claude/statusline.sh" "$HOME/.claude/statusline.sh"
chmod +x "$HOME/.claude/statusline.sh"
# The status bar's other agents: the shared writer, plus the hook that calls it in agy and in Codex.
sh "$ROOT/status/install.sh" || echo "  note: status/install.sh failed, the status bar will only show Claude Code"
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
  # The picture Settings > Look shows for this layout (the layout names it in "preview").
  cp "$ROOT/layouts/VNH.png" "$HERDR/layouts/VNH.png"
  echo "keys: merge keys/vnh.json into keys.json"
  backup "$HERDR/keys.json"
  KEYS="$HERDR/keys.json"; [ -s "$KEYS" ] || echo "{}" > "$KEYS"
  jq -s '.[0] * .[1]' "$KEYS" "$ROOT/keys/vnh.json" > "$KEYS.tmp" && mv "$KEYS.tmp" "$KEYS"
  # The look settings (size, line height, contrast). The font family isn't set: the one in the screenshots is a
  # commercial font, so Herdr's default stays unless you choose another in Settings > Look.
  echo "settings: merge keys/settings-vnh.json into settings.json"
  SET="$HERDR/settings.json"; [ -s "$SET" ] || echo "{}" > "$SET"
  backup "$SET"
  jq -s '.[0] * .[1]' "$SET" "$ROOT/keys/settings-vnh.json" > "$SET.tmp" && mv "$SET.tmp" "$SET"
  command -v herdr-app >/dev/null && herdr-app do layout.switch '{"name":"VNH"}' >/dev/null || true
fi

if want --orca; then
  sh "$ROOT/themes/install.sh"
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

if want --gestures; then
  echo "gestures: HerdrPad (pinch, sideways scroll in Herdr) and PadActions (every app)"
  # Two small apps: macOS keeps Accessibility for an app more reliably than for a bare linker-signed binary. Grant
  # each once in System Settings > Privacy & Security > Accessibility; a rebuild asks again.
  # HerdrPad (gestures/HerdrPad.m), only while Herdr is in front: pinch together / apart = git pull / push, two fingers scrolling
  # sideways = the tab switcher (a popup of the repo's tabs, vnh-tabswitch; where the scroll stops, that tab is selected).
  # Signed by the certificate "VNH Local" when it exists (gestures/make-signing-cert.sh makes it once): the apps then keep their
  # Accessibility grant across rebuilds. Without it, ad hoc: macOS forgets the grant at every rebuild.
  SIGN="-"; security find-identity -v -p codesigning 2>/dev/null | grep -q '"VNH Local"' && SIGN="VNH Local"
  HERDR_BIN="$(command -v herdr-app 2>/dev/null || echo "$HOME/.local/bin/herdr-app")"
  HAPP="$HOME/Applications/HerdrPad.app"
  mkdir -p "$HAPP/Contents/MacOS" "$HOME/Library/LaunchAgents"
  clang -O2 -fobjc-arc -o "$HAPP/Contents/MacOS/herdr-pad" "$ROOT/gestures/HerdrPad.m" -framework Cocoa -framework ApplicationServices
  cp "$ROOT/gestures/Info-herdr-pad.plist" "$HAPP/Contents/Info.plist"
  codesign -f -s "$SIGN" --identifier dev.vnh.herdr-pad "$HAPP"
  PL="$HOME/Library/LaunchAgents/dev.vnh.herdr-pad.plist"
  if [ -f "$PL" ]; then launchctl bootout "gui/$(id -u)" "$PL" 2>/dev/null || true; backup "$PL"; fi
  pkill -x herdr-pad 2>/dev/null || true
  sed -e "s#HOME_DIR#$HOME#g" -e "s#HERDR_APP_BIN#$HERDR_BIN#g" "$ROOT/gestures/dev.vnh.herdr-pad.plist" > "$PL"
  launchctl bootstrap "gui/$(id -u)" "$PL"

  # Trackpad actions in every app (gestures/PadActions.m): four fingers swiping down = cmd-W, up = cmd-T, tapping = cmd-shift-T;
  # one finger sliding along the right edge = volume, along the top edge = brightness. It reads the raw touches (private
  # MultitouchSupport framework). Same ad hoc signed app, same one-time Accessibility grant (again after a rebuild). Turn macOS's
  # own four-finger vertical swipe off (Trackpad > More Gestures > Mission Control / App Expose), or it fires too.
  PADAPP="$HOME/Applications/PadActions.app"
  mkdir -p "$PADAPP/Contents/MacOS"
  clang -O2 -fobjc-arc -o "$PADAPP/Contents/MacOS/pad-actions" "$ROOT/gestures/PadActions.m" -F/System/Library/PrivateFrameworks \
    -framework MultitouchSupport -framework DisplayServices -framework Cocoa -framework AudioToolbox -framework CoreAudio -framework ApplicationServices
  cp "$ROOT/gestures/Info-pad-actions.plist" "$PADAPP/Contents/Info.plist"
  codesign -f -s "$SIGN" --identifier dev.vnh.pad-actions "$PADAPP"
  PF="$HOME/Library/LaunchAgents/dev.vnh.pad-actions.plist"
  if [ -f "$PF" ]; then launchctl bootout "gui/$(id -u)" "$PF" 2>/dev/null || true; backup "$PF"; fi
  pkill -x pad-actions 2>/dev/null || true
  sed -e "s#HOME_DIR#$HOME#g" -e "s#HERDR_APP_BIN#$HERDR_BIN#g" "$ROOT/gestures/dev.vnh.pad-actions.plist" > "$PF"
  launchctl bootstrap "gui/$(id -u)" "$PF"
fi

if command -v herdr-app >/dev/null; then
  for mod in $MODS; do herdr-app check "$HERDR/mods/$mod"; done
fi
echo "done"

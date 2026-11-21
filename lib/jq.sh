# Source this after setting TOOLKIT_ROOT (the repo's root). Defines jq(): the jq this repo ships in bin/ for
# this OS and CPU (official builds, checked against jq's own sha256sum.txt: bin/jq-1.8.1.sha256sum), else the
# jq found on PATH. The installers use it, so a machine needs no jq of its own to install.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) JQ="$TOOLKIT_ROOT/bin/jq-macos-arm64" ;;
  Darwin-x86_64) JQ="$TOOLKIT_ROOT/bin/jq-macos-amd64" ;;
  MINGW*|MSYS*|CYGWIN*) JQ="$TOOLKIT_ROOT/bin/jq-windows-amd64.exe" ;;
  *) JQ="" ;;
esac
if [ -z "$JQ" ] || [ ! -x "$JQ" ]; then
  JQ=$(command -v jq 2>/dev/null) || { echo "jq: this repo has no build for $(uname -s)-$(uname -m) and none is on PATH" >&2; exit 1; }
fi
jq() { "$JQ" "$@"; }

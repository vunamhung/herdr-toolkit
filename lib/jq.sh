# Source this after setting TOOLKIT_ROOT (the repo's root). Defines jq(): the jq this repo ships in bin/ for
# this OS and CPU (verified against bin/jq-1.8.1.sha256sum), else the jq found on PATH.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) JQ="$TOOLKIT_ROOT/bin/jq-macos-arm64" ;;
  Darwin-x86_64) JQ="$TOOLKIT_ROOT/bin/jq-macos-amd64" ;;
  MINGW*|MSYS*|CYGWIN*) JQ="$TOOLKIT_ROOT/bin/jq-windows-amd64.exe" ;;
  *) JQ="" ;;
esac
if [ -n "$JQ" ] && [ -x "$JQ" ] && [ -f "$TOOLKIT_ROOT/bin/jq-1.8.1.sha256sum" ]; then
  _jq_name="$(basename "$JQ")"
  _jq_want="$(awk -v f="$_jq_name" '$2 == f {print $1}' "$TOOLKIT_ROOT/bin/jq-1.8.1.sha256sum")"
  if [ -n "$_jq_want" ]; then
    _jq_got=""
    if command -v shasum >/dev/null 2>&1; then _jq_got="$(shasum -a 256 "$JQ" | awk '{print $1}')"
    elif command -v sha256sum >/dev/null 2>&1; then _jq_got="$(sha256sum "$JQ" | awk '{print $1}')"; fi
    if [ -n "$_jq_got" ] && [ "$_jq_got" != "$_jq_want" ]; then
      echo "jq: checksum mismatch for $JQ" >&2; exit 1
    fi
  fi
fi
if [ -z "$JQ" ] || [ ! -x "$JQ" ]; then
  JQ=$(command -v jq 2>/dev/null) || { echo "jq: this repo has no build for $(uname -s)-$(uname -m) and none is on PATH" >&2; exit 1; }
fi
jq() { "$JQ" "$@"; }

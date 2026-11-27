#!/usr/bin/env python3
# A file in Neovim, in a tab of its own (the Files panel: a double press on a file):
#   nvim-open.py <file> [tab to go back to]
# Esc in Neovim's normal mode quits it (`:q`: a buffer with unsaved changes refuses, so nothing is lost; the mapping is added after your own
# config, for this start only). When Neovim ends, the tab you came from is shown again and this terminal (so this tab) is closed.
import json, os, subprocess, sys

path = sys.argv[1]
back = sys.argv[2] if len(sys.argv) > 2 else ""
try:
    subprocess.call(["nvim", "-c", "nnoremap <silent> <Esc> <Cmd>q<CR>", "--", path])
except FileNotFoundError:
    print("Neovim (nvim) is not installed or not on the PATH. Press Enter to close.")
    try: input()
    except EOFError: pass
if back:
    subprocess.call(["herdr-app", "do", "tab.select", json.dumps({"id": back})], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
term = os.environ.get("HC_TERMINAL_ID")
if term:
    subprocess.call(["hc", "kill", term], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Herdr runs this inside `zsh -lic "$@"; exec zsh -li`: killing the terminal leaves that shell behind as an orphan, so end it too.
    try:
        parent = os.getppid()
        cmd = subprocess.run(["ps", "-o", "command=", "-p", str(parent)], capture_output=True, text=True).stdout
        if parent > 1 and "zsh" in cmd and "-lic" in cmd:
            os.kill(parent, 9)
    except Exception:
        pass

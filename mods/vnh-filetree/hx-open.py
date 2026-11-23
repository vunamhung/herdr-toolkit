#!/usr/bin/env python3
# A file in Helix, in a tab of its own (the Files panel: a press on the blank after a name):
#   hx-open.py <file> [tab to go back to]
# Esc in Helix's normal mode quits it (a copy of your ~/.config/helix/config.toml with `esc = ":quit"` under [keys.normal], unless you
# bound esc yourself; a buffer with unsaved changes refuses to quit, as with :q). When Helix ends, the tab you came from is shown again
# and this terminal (so this tab) is closed.
import json, os, re, subprocess, sys

path = sys.argv[1]
back = sys.argv[2] if len(sys.argv) > 2 else ""
home = os.path.expanduser("~")
cfg_home = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
src = os.path.join(cfg_home, "helix", "config.toml")
try:
    text = open(src, encoding="utf-8").read()
except OSError:
    text = ""
# Esc quits from the normal mode: the config is copied with its own binding of esc there (often "collapse the selection") replaced.
out, section, skipping, seen = [], "", False, False
for line in text.split("\n"):
    stripped = line.strip()
    if skipping:                                   # the rest of a multi-line value of the esc we are dropping
        if "]" in stripped: skipping = False
        continue
    m = re.match(r"^\[([^\]]+)\]\s*(#.*)?$", stripped)
    if m:
        section = m.group(1).strip()
        out.append(line)
        if section == "keys.normal":
            out.append('esc = ":quit"')
            seen = True
        continue
    if section == "keys.normal" and re.match(r"^esc\s*=", stripped):
        if "[" in stripped and "]" not in stripped: skipping = True
        continue
    out.append(line)
text = "\n".join(out)
if not seen:
    text += '\n[keys.normal]\nesc = ":quit"\n'
cache = os.path.join(home, ".cache", "vnh-hx")
os.makedirs(cache, exist_ok=True)
cfg = os.path.join(cache, "config.toml")
with open(cfg, "w", encoding="utf-8") as f:
    f.write(text)

try:
    subprocess.call(["hx", "-c", cfg, path])
except FileNotFoundError:
    print("Helix (hx) is not installed or not on the PATH. Press Enter to close.")
    try: input()
    except EOFError: pass

if back:
    subprocess.call(["herdr-app", "do", "tab.select", json.dumps({"id": back})], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
term = os.environ.get("HC_TERMINAL_ID")
if term:
    subprocess.call(["hc", "kill", term], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

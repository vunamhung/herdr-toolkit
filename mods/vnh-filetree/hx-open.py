#!/usr/bin/env python3
# A file in Helix, in a tab of its own (the Files panel: a press on the blank after a name):
#   hx-open.py <file> [tab to go back to] [Herdr's background colour, #rrggbb]
# One Helix tab per space: it registers itself in ~/.cache/vnh-hx/registry.json, and the Files panel, finding it, writes the next file's path
# to ~/.cache/vnh-hx/open-<terminal> and presses Alt-o in it (bound below to `:open` of that path) instead of starting another tab.
# Esc in Helix's normal mode quits it (a copy of your ~/.config/helix/config.toml with `esc = ":quit"` under [keys.normal], unless you
# bound esc yourself; a buffer with unsaved changes refuses to quit, as with :q). When Helix ends, the tab you came from is shown again
# and this terminal (so this tab) is closed.
import json, os, re, subprocess, sys

path = sys.argv[1]
back = sys.argv[2] if len(sys.argv) > 2 else ""
bg = sys.argv[3] if len(sys.argv) > 3 else ""
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
# Space m: the rendered Markdown of the open file in a tab of Herdr (hx-md.py), unless you bound space m yourself.
md = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hx-md.py")
bind = "m = '" + ":sh python3 -I " + md + ' "%{buffer_name}"' + "'"
if not re.search(r"^\s*m\s*=", text, re.M) or not re.search(r"^\s*\[keys\.normal\.space\]", text, re.M):
    if re.search(r"^\s*\[keys\.normal\.space\]\s*$", text, re.M):
        text = re.sub(r"^(\s*\[keys\.normal\.space\]\s*)$", lambda m: m.group(1) + "\n" + bind, text, count=1, flags=re.M)
    else:
        text += "\n[keys.normal.space]\n" + bind + "\n"
# Helix's background is Herdr's: your theme (theme = "..." in the config) is copied as `vnh-herdr` with every `bg` that was the theme's
# main background replaced by Herdr's, so only that colour changes (the file is written next to your themes and rewritten at each start).
def toml_style(v):
    if isinstance(v, str): return '"%s"' % v.replace("\\", "\\\\").replace('"', '\\"')
    if isinstance(v, list): return "[" + ", ".join(toml_style(x) for x in v) + "]"
    if isinstance(v, dict): return "{ " + ", ".join("%s = %s" % (k, toml_style(x)) for k, x in v.items()) + " }"
    return str(v)

m = re.match(r"^#?([0-9a-fA-F]{6})", bg or "")
tm = re.search(r'^\s*theme\s*=\s*"([^"]+)"', text, re.M)
if m and tm and tm.group(1) != "vnh-herdr":
    try:
        import tomllib
        name = tm.group(1)
        for d in (os.path.join(cfg_home, "helix", "themes"), os.path.join(cfg_home, "helix", "runtime", "themes"), os.path.join(home, ".local", "share", "helix", "runtime", "themes")):
            f = os.path.join(d, name + ".toml")
            if os.path.exists(f):
                theme = tomllib.load(open(f, "rb"))
                pal = theme.get("palette", {})
                col = lambda c: pal.get(c, c) if isinstance(c, str) else c
                base = col((theme.get("ui.background") or {}).get("bg"))
                if base:
                    lines = ['inherits = "%s"' % name]
                    for key, val in theme.items():
                        if isinstance(val, dict) and key != "palette" and val.get("bg") is not None and col(val["bg"]) == base:
                            lines.append('"%s" = %s' % (key, toml_style({**val, "bg": "#" + m.group(1)})))
                    tdir = os.path.join(cfg_home, "helix", "themes")
                    os.makedirs(tdir, exist_ok=True)
                    open(os.path.join(tdir, "vnh-herdr.toml"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
                    text = text.replace(tm.group(0), tm.group(0).split("=")[0] + '= "vnh-herdr"', 1)
                break
    except Exception:
        pass
def add_key(txt, table, key, value):
    """Binds `key` in [table] (dropping a one-line binding of it there), creating the table when it is missing."""
    line = '"%s" = %s' % (key, value)
    out, section, seen = [], "", False
    for ln in txt.split("\n"):
        m = re.match(r"^\[([^\]]+)\]\s*(#.*)?$", ln.strip())
        if m:
            section = m.group(1).strip()
            out.append(ln)
            if section == table:
                out.append(line); seen = True
            continue
        if section == table and re.match(r'^"?%s"?\s*=' % re.escape(key), ln.strip()):
            continue
        out.append(ln)
    txt = "\n".join(out)
    return txt if seen else txt + "\n[%s]\n%s\n" % (table, line)

term = os.environ.get("HC_TERMINAL_ID", "")
cache = os.path.join(home, ".cache", "vnh-hx")
os.makedirs(cache, exist_ok=True)
req = os.path.join(cache, "open-" + (term or "x"))
open(req, "w").close()
for table in ("keys.normal", "keys.insert", "keys.select"):
    text = add_key(text, table, "A-o", "':open \"%%sh{cat %s}\"'" % req)
cfg = os.path.join(cache, "config-%s.toml" % (term or "x"))
with open(cfg, "w", encoding="utf-8") as f:
    f.write(text)

import tempfile
def registry(add):
    try:
        space = json.loads(subprocess.run(["hc", "get", term, "--json"], capture_output=True, text=True).stdout).get("labels", {}).get("herdr.space")
        f = os.path.join(cache, "registry.json")
        try: reg = json.load(open(f))
        except Exception: reg = {}
        if add and space: reg[space] = term
        else: reg = {k: v for k, v in reg.items() if v != term}
        tmp = f + ".%d" % os.getpid()
        json.dump(reg, open(tmp, "w")); os.replace(tmp, f)
    except Exception:
        pass
if term: registry(True)
try:
    subprocess.call(["hx", "-c", cfg, path])
except FileNotFoundError:
    print("Helix (hx) is not installed or not on the PATH. Press Enter to close.")
    try: input()
    except EOFError: pass

if term: registry(False)
if back:
    subprocess.call(["herdr-app", "do", "tab.select", json.dumps({"id": back})], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
term = os.environ.get("HC_TERMINAL_ID")
if term:
    subprocess.call(["hc", "kill", term], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

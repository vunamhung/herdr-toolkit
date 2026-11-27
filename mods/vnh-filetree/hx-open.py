#!/usr/bin/env python3
# A file in Helix, in a tab of its own (the Files panel: a press on the blank after a name):
#   hx-open.py <file> [tab to go back to] [Herdr's background colour, #rrggbb]
# Esc in Helix's normal mode quits it (a copy of your ~/.config/helix/config.toml with `esc = ":quit"` under [keys.normal], unless you
# bound esc yourself; a buffer with unsaved changes refuses to quit, as with :q). When Helix ends, the tab you came from is shown again
# and this terminal (so this tab) is closed.
import json, os, re, shlex, subprocess, sys

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
# Arguments are shell-quoted and encoded as a TOML basic string so filenames with $(), backticks, spaces, or quotes cannot inject commands.
md = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hx-md.py")
bind = "m = " + json.dumps(f":sh python3 -I {shlex.quote(md)} {shlex.quote(path)}")
out2, sec2, has_space_sec, has_space_m = [], "", False, False
for line in text.split("\n"):
    stripped = line.strip()
    sm = re.match(r"^\[([^\]]+)\]\s*(#.*)?$", stripped)
    if sm:
        sec2 = sm.group(1).strip()
        if sec2 == "keys.normal.space": has_space_sec = True
    elif sec2 == "keys.normal.space" and re.match(r"^m\s*=", stripped):
        has_space_m = True
    out2.append(line)
if not has_space_m:
    if has_space_sec:
        final, inserted = [], False
        for line in out2:
            final.append(line)
            sm = re.match(r"^\[([^\]]+)\]\s*(#.*)?$", line.strip())
            if not inserted and sm and sm.group(1).strip() == "keys.normal.space":
                final.append(bind)
                inserted = True
        text = "\n".join(final)
    else:
        text = "\n".join(out2) + "\n[keys.normal.space]\n" + bind + "\n"
# Helix's background is Herdr's: your theme (theme = "..." in the config) is copied as `vnh-herdr` with every `bg` that was the theme's
# main background replaced by Herdr's, so only that colour changes (the file is written next to your themes and rewritten at each start).
def toml_style(v):
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, str): return json.dumps(v)
    if isinstance(v, list): return "[" + ", ".join(toml_style(x) for x in v) + "]"
    if isinstance(v, dict): return "{ " + ", ".join("%s = %s" % (json.dumps(str(k)), toml_style(x)) for k, x in v.items()) + " }"
    return str(v)

def atomic_write(dst, content):
    tmp = f"{dst}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(content)
    os.replace(tmp, dst)

m = re.match(r"^#?([0-9a-fA-F]{6})", bg or "")
tm = re.search(r'^\s*theme\s*=\s*"([^"]+)"', text, re.M)
if m and tm and tm.group(1) != "vnh-herdr":
    try:
        import tomllib
        name = tm.group(1)
        for d in (os.path.join(cfg_home, "helix", "themes"), os.path.join(cfg_home, "helix", "runtime", "themes"), os.path.join(home, ".local", "share", "helix", "runtime", "themes")):
            f = os.path.join(d, name + ".toml")
            if os.path.exists(f):
                with open(f, "rb") as tf:
                    theme = tomllib.load(tf)
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
                    atomic_write(os.path.join(tdir, "vnh-herdr.toml"), "\n".join(lines) + "\n")
                    text = text.replace(tm.group(0), tm.group(0).split("=")[0] + '= "vnh-herdr"', 1)
                break
    except Exception:
        pass
cache = os.path.join(home, ".cache", "vnh-hx")
os.makedirs(cache, exist_ok=True)
cfg = os.path.join(cache, "config.toml")
atomic_write(cfg, text)

try:
    subprocess.call(["hx", "-c", cfg, "--", path])
except FileNotFoundError:
    print("Helix (hx) is not installed or not on the PATH. Press Enter to close.")
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

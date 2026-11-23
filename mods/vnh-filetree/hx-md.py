#!/usr/bin/env python3
# The rendered Markdown of the file Helix has open, in a tab of Herdr (Space m in Helix, bound by hx-open.py):
#   hx-md.py <file as Helix names it>
# The preview tab (vnh-markdown) reads the file again every 2 s, so saving in Helix updates it; Esc there closes it and shows the Helix tab.
import json, os, subprocess, sys

path = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else ""
if not path.lower().endswith((".md", ".markdown", ".mdx")):
    print("Not a Markdown file")
    sys.exit(0)
tab = ""
try:
    tab = json.loads(subprocess.run(["herdr-app", "status"], capture_output=True, text=True).stdout).get("tab", "")
except Exception:
    pass
args = {"name": os.path.basename(path)[:40], "mod": "vnh-markdown", "props": {"path": path, "back": tab or None}}
subprocess.run(["herdr-app", "do", "tab.new", json.dumps(args)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

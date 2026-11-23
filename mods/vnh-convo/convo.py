#!/usr/bin/env python3
# The turns of one conversation, for the preview tab (vnh-convo):
#   convo.py <agent> <id> <file> <prompts.py>
# prints {"turns": [{"at": iso or null, "text": your prompt, "reply": the agent's last words before your next prompt}], "note": ""}
# claude: the transcript `file` through prompts.py (vnh-prompts); agy: its history file only keeps your prompts; codex: the rollout file.
import glob, json, os, re, subprocess, sys

agent, cid, path = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else ""
prompts_py = sys.argv[4] if len(sys.argv) > 4 else ""
home = os.path.expanduser("~")
turns, note = [], ""

def clean(t): return re.sub(r"[ \t]+\n", "\n", t or "").strip()

if agent == "claude":
    if path and os.path.exists(path) and prompts_py and os.path.exists(prompts_py):
        r = subprocess.run([sys.executable, "-I", prompts_py, path, ""], capture_output=True, text=True)
        try:
            for p in json.loads(r.stdout).get("prompts", []):
                turns.append({"at": p.get("at"), "text": p.get("text") or "", "reply": p.get("reply") or ""})
        except Exception:
            note = "Could not read this conversation."
    else:
        note = "The conversation file is gone."
elif agent == "agy":
    hist = os.path.join(home, ".gemini/antigravity-cli/history.jsonl")
    if os.path.exists(hist):
        import datetime
        for line in open(hist, encoding="utf-8", errors="replace"):
            try: j = json.loads(line)
            except Exception: continue
            if j.get("conversationId") != cid: continue
            ts = j.get("timestamp")
            at = datetime.datetime.fromtimestamp(ts / 1000, datetime.timezone.utc).isoformat() if ts else None
            turns.append({"at": at, "text": j.get("display") or "", "reply": ""})
    note = "Antigravity keeps only your prompts outside its own database: the replies are not shown."
elif agent == "codex":
    files = glob.glob(os.path.join(home, ".codex/sessions/**/rollout-*%s*.jsonl" % re.sub(r"[^0-9a-f-]", "", cid)), recursive=True)
    if files:
        cur = None
        for line in open(files[0], encoding="utf-8", errors="replace"):
            try: j = json.loads(line)
            except Exception: continue
            p = j.get("payload") or {}
            if j.get("type") != "response_item" or p.get("type") != "message": continue
            text = clean("\n".join(x.get("text", "") for x in p.get("content", []) if isinstance(x, dict)))
            if not text: continue
            if p.get("role") == "user":
                if text.startswith("<"): continue
                cur = {"at": j.get("timestamp"), "text": text, "reply": ""}
                turns.append(cur)
            elif p.get("role") == "assistant" and cur is not None:
                cur["reply"] = text
    else:
        note = "The conversation file is gone."
print(json.dumps({"turns": turns, "note": note}))

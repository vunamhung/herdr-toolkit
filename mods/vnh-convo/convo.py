#!/usr/bin/env python3
# The turns of one conversation, for the preview tab (vnh-convo):
#   convo.py <agent> <id> <file> <prompts.py>
# prints {"turns": [{"at": iso or null, "text": your prompt, "reply": the agent's last words before your next prompt}], "note": ""}
# claude: the transcript `file` through prompts.py (vnh-prompts); agy: its conversation database (your prompts and its replies); codex: the rollout file.
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
    # Antigravity's own conversation file (SQLite): a step of type 14 is something you typed (field 19.2), a step of type 15 is the
    # model speaking: its words are field 20.1 (the reply; 20.3 is its reasoning, 20.7 the tool calls). A turn's reply is the last
    # words before your next message.
    import datetime, sqlite3
    def varint(b, i):
        n = sh = 0
        while True:
            c = b[i]; i += 1; n |= (c & 0x7f) << sh; sh += 7
            if not c & 0x80: return n, i
    def sub(b, path):
        for want in path:
            i, found = 0, None
            try:
                while i < len(b):
                    tag, i = varint(b, i); f, w = tag >> 3, tag & 7
                    if w == 0: _, i = varint(b, i)
                    elif w == 2:
                        l, i = varint(b, i)
                        if f == want and found is None: found = b[i:i + l]; break
                        i += l
                    elif w == 1: i += 8
                    elif w == 5: i += 4
                    else: break
            except Exception:
                return None
            if found is None: return None
            b = found
        return b
    def when(md):
        got = sub(bytes(md), [1])
        try:
            if got and got[:1] == b"\x08":
                sec, _ = varint(got, 1)
                return datetime.datetime.fromtimestamp(sec, datetime.timezone.utc).isoformat()
        except Exception:
            pass
        return None
    db = os.path.join(home, ".gemini/antigravity-cli/conversations", cid + ".db")
    if os.path.exists(db):
        try:
            con = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=2)
            cur = None
            for idx, md, st, pl in con.execute("select idx, metadata, step_type, step_payload from steps where step_type in (14, 15) order by idx"):
                pl = bytes(pl or b"")
                if st == 14:
                    t = sub(pl, [19, 2])
                    if t:
                        cur = {"at": when(md), "text": t.decode("utf8", "replace"), "reply": ""}
                        turns.append(cur)
                elif cur is not None:
                    t = sub(pl, [20, 1])
                    if t and t.strip(): cur["reply"] = t.decode("utf8", "replace")
        except Exception:
            note = "Could not read this conversation."
    if not turns and not note:
        hist = os.path.join(home, ".gemini/antigravity-cli/history.jsonl")
        if os.path.exists(hist):
            for line in open(hist, encoding="utf-8", errors="replace"):
                try: j = json.loads(line)
                except Exception: continue
                if j.get("conversationId") != cid: continue
                ts = j.get("timestamp")
                at = datetime.datetime.fromtimestamp(ts / 1000, datetime.timezone.utc).isoformat() if ts else None
                turns.append({"at": at, "text": j.get("display") or "", "reply": ""})
            note = "Only your prompts are left of this conversation: its file is gone."
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

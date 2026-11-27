#!/usr/bin/env python3
"""Shared conversation discovery and summary parser for Claude Code, Antigravity, and Codex.

Subcommands:
  list-claude [--limit N] [--slug SLUG]   -> JSON {"files": [[mtime, path], ...]}
  read-claude <path> [...]                -> JSONL of Claude conversation summaries
  list-others                             -> JSONL of Antigravity and Codex summaries
"""
import glob
import json
import os
import re
import sys

HOME = os.path.expanduser("~")
SKIP_PREFIXES = ("<", )


def clean(text):
    return re.sub(r"\s+", " ", text or "").strip()


def safe_mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def claude_projects_dir():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
    return os.path.join(base, "projects")


def list_claude(limit=400, slug=None):
    root = claude_projects_dir()
    if not os.path.isdir(root):
        return []
    dirs = []
    try:
        entries = os.listdir(root)
    except OSError:
        return []
    for name in entries:
        if slug and not (name == slug or name.startswith(slug + "-")):
            continue
        full = os.path.join(root, name)
        if os.path.isdir(full):
            dirs.append(full)
    found = []
    for d in dirs:
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for fn in names:
            if not fn.endswith(".jsonl"):
                continue
            path = os.path.join(d, fn)
            mt = safe_mtime(path)
            if mt > 0:
                found.append((int(mt), path))
    found.sort(key=lambda x: x[0], reverse=True)
    return found[:limit]


def prompt_text(rec):
    msg = (rec or {}).get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return clean(content)
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text") or "")
        return clean(" ".join(parts))
    return ""


def read_claude_file(path):
    title_rec = None
    first_user = None
    user_count = 0
    sdk = False
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if not sdk and '"sdk-' in line and re.search(r'"entrypoint"\s*:\s*"sdk-', line):
                    sdk = True
                if '"custom-title"' in line or '"ai-title"' in line or '"agent-name"' in line:
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    if rec.get("type") in ("custom-title", "ai-title", "agent-name"):
                        title_rec = rec
                if ('"type":"user"' in line or '"type": "user"' in line) and '"tool_result"' not in line:
                    if '"isMeta":true' in line or '"isMeta": true' in line:
                        continue
                    user_count += 1
                    if first_user is None and '"isSidechain":true' not in line and '"isSidechain": true' not in line:
                        try:
                            rec = json.loads(line)
                        except ValueError:
                            continue
                        if rec.get("type") == "user" and not rec.get("isMeta") and not rec.get("isSidechain"):
                            txt = prompt_text(rec)
                            if txt and not txt.startswith(SKIP_PREFIXES):
                                first_user = rec
    except OSError:
        return None
    title = ""
    if title_rec:
        title = title_rec.get("customTitle") or title_rec.get("title") or title_rec.get("aiTitle") or title_rec.get("agentName") or ""
    cid = os.path.basename(path)
    if cid.endswith(".jsonl"):
        cid = cid[:-6]
    return {
        "f": path,
        "id": cid,
        "m": int(safe_mtime(path)),
        "n": user_count,
        "title": title,
        "prompt": prompt_text(first_user)[:240] if first_user else "",
        "cwd": (first_user or {}).get("cwd"),
        "branch": (first_user or {}).get("gitBranch"),
        "sdk": sdk,
    }


def list_others():
    out = []
    hist = os.path.join(HOME, ".gemini", "antigravity-cli", "history.jsonl")
    if os.path.isfile(hist):
        convs = {}
        try:
            with open(hist, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    try:
                        j = json.loads(line)
                    except ValueError:
                        continue
                    cid = j.get("conversationId")
                    if not isinstance(cid, str) or not cid or os.path.basename(cid) != cid:
                        continue
                    c = convs.setdefault(cid, {"first": None, "n": 0, "m": 0.0, "cwd": None})
                    t = clean(j.get("display"))
                    if c["first"] is None and t:
                        c["first"] = t[:240]
                    c["n"] += 1
                    ts = j.get("timestamp")
                    if isinstance(ts, (int, float)):
                        c["m"] = max(c["m"], ts / 1000.0)
                    c["cwd"] = j.get("workspace") or c["cwd"]
        except OSError:
            pass
        conv_dir = os.path.join(HOME, ".gemini", "antigravity-cli", "conversations")
        for cid, c in convs.items():
            db = os.path.join(conv_dir, cid + ".db")
            if os.path.isfile(db):
                c["m"] = max(c["m"], safe_mtime(db))
            out.append({"agent": "agy", "id": cid, "m": int(c["m"]), "n": c["n"], "title": "", "prompt": c["first"] or "", "cwd": c["cwd"]})

    codex_home = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
    pattern = os.path.join(codex_home, "sessions", "**", "rollout-*.jsonl")
    files = sorted(glob.glob(pattern, recursive=True), key=safe_mtime, reverse=True)[:300]
    for path in files:
        sid = cwd = first = None
        n = 0
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh):
                    if i > 4000:
                        break
                    try:
                        j = json.loads(line)
                    except ValueError:
                        continue
                    p = j.get("payload") or {}
                    if j.get("type") == "session_meta":
                        sid = p.get("id") or sid
                        cwd = p.get("cwd") or cwd
                    elif j.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
                        content = p.get("content") or []
                        t = clean(" ".join((x.get("text") or "") for x in content if isinstance(x, dict)))
                        if t and not t.startswith("<"):
                            n += 1
                            if first is None:
                                first = t[:240]
        except OSError:
            continue
        if sid and n:
            out.append({"agent": "codex", "id": sid, "m": int(safe_mtime(path)), "n": n, "title": "", "prompt": first or "", "cwd": cwd})
    return out


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if not args:
        return 2
    cmd = args[0]
    if cmd == "list-claude":
        limit, slug = 400, None
        i = 1
        while i < len(args):
            if args[i] == "--limit" and i + 1 < len(args):
                limit = max(1, int(args[i + 1]))
                i += 2
            elif args[i] == "--slug" and i + 1 < len(args):
                slug = args[i + 1] or None
                i += 2
            else:
                i += 1
        print(json.dumps({"files": list_claude(limit=limit, slug=slug)}))
        return 0
    if cmd == "read-claude":
        for path in args[1:]:
            rec = read_claude_file(path)
            if rec is not None:
                print(json.dumps(rec))
        return 0
    if cmd == "list-others":
        for rec in list_others():
            print(json.dumps(rec))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())

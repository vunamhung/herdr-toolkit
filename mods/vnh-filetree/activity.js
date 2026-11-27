// Agent file-activity tracking (Claude hook bridge + Antigravity SQLite step reader) for vnh-filetree.
import { agents, focused, panes, exec, readTextFile, watchFolder, home } from "herdr";
import { relTo } from "./git.js";

const READ_REVEAL = 12, SEARCH_REVEAL = 60;

// Antigravity (agy) records every step in a SQLite file named after the session.
// Reads tool steps after `last` without stalling forever on non-3 terminal statuses (only stops on in-progress status 1/2).
const AGY_PY = String.raw`
import contextlib, json, os, re, sqlite3, sys
from pathlib import Path
base = os.path.expanduser("~/.gemini/antigravity-cli/conversations")
for arg in sys.argv[1:]:
    sid, _, last_s = arg.rpartition(":")
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", sid): continue
    db_path = os.path.join(base, sid + ".db")
    if not os.path.isfile(db_path): continue
    try:
        last = int(last_s)
        uri = Path(db_path).resolve().as_uri() + "?mode=ro"
        with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=1)) as db:
            if last < 0:
                top = db.execute("select max(idx) from steps").fetchone()[0]
                print(json.dumps({"session": sid, "max": top if top is not None else -1}))
                continue
            rows = db.execute("select idx, status, step_payload from steps where step_type=132 and idx>? order by idx", (last,)).fetchall()
    except Exception:
        continue
    new = last
    for idx, status, pl in rows:
        if status in (0, 1, 2): break
        new = idx
        if status != 3: continue
        b = bytes(pl or b"")
        for tool, kind in ((b"read_file", "read"), (b"edit_file", "write"), (b"write_file", "write")):
            i = b.find(tool + b"\x1a")
            if i < 0: continue
            m = re.search(rb'"Path":"((?:[^"\\]|\\.)*)"', b[i:i + 400000])
            if m:
                try: path = json.loads(b'"' + m.group(1) + b'"')
                except Exception: break
                if path.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", path):
                    print(json.dumps({"session": sid, "kind": kind, "path": path}))
            break
    print(json.dumps({"session": sid, "max": new}))
`;

export function watchActivity(view, cx) {
  const dir = `${home()}/.local/state/herdr-filetree`;
  cx.spawn(async (cx) => {
    try { await exec("mkdir", ["-p", dir]); } catch {}
    try {
      for (;;) {
        await watchFolder(dir);
        await readActivity(view, `${dir}/activity.jsonl`, cx);
      }
    } catch {}
  });
}

export async function readActivity(view, file, cx) {
  const text = await readTextFile(file).catch(() => null);
  if (!text) return;
  const fresh = [];
  let maxAt = view.seenAt;
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.at > view.seenAt) { fresh.push(e); if (e.at > maxAt) maxAt = e.at; }
    } catch {}
  }
  if (!fresh.length) return;
  view.seenAt = maxAt;
  const mode = view.config.activity, reads = mode === "reads and writes" || mode === "reads", writes = mode === "reads and writes" || mode === "writes";
  for (const e of fresh) {
    if (e.kind === "read" && reads) view.flash(e.paths ?? [], "purple", cx, e.paths?.length > 1 ? SEARCH_REVEAL : READ_REVEAL, e.session);
    else if (e.kind === "write" && writes) view.flash(e.paths ?? [], "orange", cx, READ_REVEAL, e.session);
    else if (e.kind === "mention") { if (view.isMine(e.session)) view.reveal(e.paths ?? [], cx); }
    else if (e.kind === "bash-start") {
      if (view.bashStarts.size > 200) view.bashStarts.clear();
      view.bashStarts.set(e.id, e.at);
    } else if (e.kind === "bash-end" && writes) {
      const start = view.bashStarts.get(e.id) ?? e.at - 5000;
      view.bashStarts.delete(e.id);
      cx.timer.after(1200, (cx) => {
        const paths = new Set();
        for (const r of view.recent) if (r.at >= start - 300 && r.at <= e.at + 1200) for (const p of r.paths) {
          const rel = relTo(view.root, p);
          if (rel && rel !== ".git" && !rel.startsWith(".git/") && !view.isIgnored(rel)) paths.add(p);
        }
        view.flash([...paths].slice(0, 60), "orange", cx, READ_REVEAL, e.session);
      });
    } else if (e.kind === "git") view.gitEvent(e, cx);
  }
  cx.notify();
}

export async function pollAgy(view, cx) {
  if (view.agyBusy) return;
  view.agyBusy = true;
  try {
    const sessions = new Set(), liveSessions = new Set(), now = Date.now();
    view.agyHot ??= new Map();
    for (const a of agents()) {
      const text = await readTextFile(`${home()}/.cache/herdr-status/${a.address}.json`).catch(() => null);
      try {
        const j = JSON.parse(text ?? "{}");
        if (j.provider === "agy" && j.session) {
          liveSessions.add(j.session);
          if (a.status === "working") view.agyHot.set(j.session, now);
        }
      } catch {}
    }
    for (const [sid, at] of view.agyHot) { if (now - at < 10000) sessions.add(sid); else view.agyHot.delete(sid); }
    for (const sid of [...view.agyLast.keys()]) if (!liveSessions.has(sid) && !sessions.has(sid)) view.agyLast.delete(sid);
    if (!sessions.size) return;
    const r = await exec("python3", ["-I", "-c", AGY_PY, ...[...sessions].map((sid) => `${sid}:${view.agyLast.get(sid) ?? -1}`)]).catch(() => null);
    if (!r || r.code !== 0) return;
    const mode = view.config.activity, reads = mode === "reads and writes" || mode === "reads", writes = mode === "reads and writes" || mode === "writes";
    for (const line of r.stdout.split("\n")) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.max != null) view.agyLast.set(e.session, e.max);
      else if (e.kind === "read" && reads) view.flash([e.path], "purple", cx, READ_REVEAL, e.session);
      else if (e.kind === "write" && writes) view.flash([e.path], "orange", cx, READ_REVEAL, e.session);
    }
  } finally { view.agyBusy = false; }
}

export async function readMine(view) {
  const f = focused();
  if (!f?.tab) return;
  const fp = f.pane ? panes().find((p) => p.pane === f.pane) : null;
  const terms = fp?.status && fp.terminal ? [fp.terminal] : agents().filter((a) => a.tab === f.tab).map((a) => a.address);
  const key = terms.join(",");
  const now = Date.now();
  if (key === view.mineKey && now - view.mineAt < 5000) return;
  view.mineKey = key; view.mineAt = now;
  const seq = (view.mineSeq = (view.mineSeq ?? 0) + 1);
  const sessions = new Set();
  view.lastSession ??= new Map();
  for (const t of terms) {
    const text = await readTextFile(`${home()}/.cache/herdr-status/${t}.json`).catch(() => null);
    if (seq !== view.mineSeq) return;
    try { const id = JSON.parse(text ?? "{}").session; if (id) view.lastSession.set(t, id); } catch {}
    if (view.lastSession.has(t)) sessions.add(view.lastSession.get(t));
  }
  const next = sessions.size ? sessions : terms.length ? new Set() : null;
  if ((next?.size ?? 0) !== (view.mine?.size ?? 0) || [...(next ?? [])].some((x) => !view.mine?.has(x))) {
    view.mine = next; view.agoAt = 0; view.dirtyMine = true;
  }
}

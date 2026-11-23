// The conversations of one repository, for the Timeline panel's list: Claude Code (~/.claude/projects, only the folders of this repo are
// read), Antigravity and Codex. Same fields and the same shared caches as the Ctrl+I popup (vnh-sessions), so each reads what the
// other has already worked out: { agent, id, f, m (unix s), n (prompts), title, prompt, cwd, branch }.
import { exec, shared, setShared } from "herdr";

export const AGENT_ICON = { claude: "icons/claude.svg", agy: "icons/antigravity.svg", codex: "icons/codex.svg" };
const CACHE = "vnh.sessions.cache.v2";

// Claude's conversation files of the folders whose name starts with the repo's (its path, every other character a "-"): newest first.
const LIST = `root="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"; [ -d "$root" ] || exit 0
for d in "$root"/$2*; do [ -d "$d" ] && ls -t "$d"/*.jsonl 2>/dev/null; done | head -n "$1" | while IFS= read -r f; do
  m=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f"); printf '%s\\t%s\\n' "$m" "$f"; done`;
const READ = `for f in "$@"; do
  t=$(grep -E '"type":"(custom-title|ai-title|agent-name)"' "$f" | tail -n 1)
  u=$(grep -m 60 '"type":"user"' "$f" | grep -v -e '"isMeta":true' -e '"tool_result"' -e '"isSidechain":true' -e '"content":"<' -e '"text":"<' | head -n 1)
  n=$(grep '"type":"user"' "$f" | grep -c -v -e '"tool_result"' -e '"isMeta":true')
  e=$(grep -m 1 -o '"entrypoint":"[a-z-]*"' "$f")
  printf '@@%s\\n%s\\n%s\\n%s\\n%s\\n' "$f" "$n" "$t" "$u" "$e"
done`;
const OTHERS = `python3 - <<'PY'
import glob, json, os, re, sys
home = os.path.expanduser("~")
out = []
def clean(t): return re.sub(r"\s+", " ", t or "").strip()
hist = os.path.join(home, ".gemini/antigravity-cli/history.jsonl")
if os.path.exists(hist):
    convs = {}
    for line in open(hist, encoding="utf-8", errors="replace"):
        try: j = json.loads(line)
        except Exception: continue
        cid = j.get("conversationId")
        if not cid: continue
        c = convs.setdefault(cid, {"first": None, "n": 0, "m": 0, "cwd": None})
        t = clean(j.get("display"))
        if c["first"] is None and t: c["first"] = t[:240]
        c["n"] += 1
        c["m"] = max(c["m"], (j.get("timestamp") or 0) / 1000)
        c["cwd"] = j.get("workspace") or c["cwd"]
    for cid, c in convs.items():
        db = os.path.join(home, ".gemini/antigravity-cli/conversations", cid + ".db")
        if os.path.exists(db): c["m"] = max(c["m"], os.path.getmtime(db))
        out.append({"agent": "agy", "id": cid, "m": int(c["m"]), "n": c["n"], "title": "", "prompt": c["first"] or "", "cwd": c["cwd"]})
files = sorted(glob.glob(os.path.join(home, ".codex/sessions/**/rollout-*.jsonl"), recursive=True), key=os.path.getmtime, reverse=True)[:300]
for f in files:
    sid = cwd = None; first = None; n = 0
    try:
        with open(f, encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if i > 4000: break
                try: j = json.loads(line)
                except Exception: continue
                p = j.get("payload") or {}
                if j.get("type") == "session_meta":
                    sid = p.get("id") or sid; cwd = p.get("cwd") or cwd
                elif j.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
                    t = clean(" ".join(x.get("text", "") for x in p.get("content", []) if isinstance(x, dict)))
                    if t and not t.startswith("<"):
                        n += 1
                        if first is None: first = t[:240]
    except Exception: continue
    if sid and n: out.append({"agent": "codex", "id": sid, "m": int(os.path.getmtime(f)), "n": n, "title": "", "prompt": first or "", "cwd": cwd})
for o in out: print(json.dumps(o))
PY`;

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
function promptText(rec) {
  const c = rec?.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join(" ") : "";
  return text.replace(/\s+/g, " ").trim();
}

export const inRepo = (s, root) => {
  const cwd = (s.cwd ?? "").replace(/\/+$/, "");
  return Boolean(root) && Boolean(cwd) && (cwd === root || cwd.startsWith(`${root}/`));
};
export function ago(sec) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
}

/** The git top level of a folder (null outside a repository). */
export async function repoRoot(cwd) {
  if (!cwd) return null;
  const r = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 8000 }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() || null : null;
}

/** Every conversation of the repository `root`, newest first. `onPart(list)` gets the ones already known while the rest is read. */
export async function loadConvos(root, onPart) {
  const cache = { ...(shared(CACHE) ?? {}) };
  const slug = root.replace(/[^A-Za-z0-9]/g, "-");
  const l = await exec("sh", ["-c", LIST, "list", "300", slug], { timeout: 15000 }).catch(() => null);
  const files = (l?.stdout ?? "").split("\n").filter(Boolean).map((x) => { const [m, f] = x.split("\t"); return { m: Number(m), f }; });
  const fresh = new Map(), stale = [];
  for (const { m, f } of files) { const old = cache[f]; if (old && old.m === m) fresh.set(f, old); else stale.push({ m, f }); }
  const claude = () => {
    const byFile = new Map(fresh); // a file read in the meantime is in both lists
    for (const x of stale) if (!byFile.has(x.f) && cache[x.f]) byFile.set(x.f, cache[x.f]);
    return [...byFile.values()].filter((x) => !x.sdk && inRepo(x, root));
  };
  const others = (shared("vnh.sessions.others") ?? []).filter((x) => inRepo(x, root));
  const all = () => claude().concat(others).sort((a, b) => b.m - a.m);
  onPart?.(all());
  for (let i = 0; i < stale.length; i += 8) {
    const batch = stale.slice(i, i + 8);
    const r = await exec("sh", ["-c", READ, "read", ...batch.map((x) => x.f)], { timeout: 60000 }).catch(() => null);
    for (const part of (r?.stdout ?? "").split("@@").filter(Boolean)) {
      const [f, n, t, u, e] = part.split("\n");
      const item = batch.find((x) => x.f === f); if (!item) continue;
      const tr = parse(t), ur = parse(u);
      const id = f.split("/").pop().replace(/\.jsonl$/, "");
      const entry = { f, id, m: item.m, n: Number(n) || 0, title: tr?.customTitle ?? tr?.title ?? tr?.aiTitle ?? tr?.agentName ?? "", prompt: promptText(ur).slice(0, 240), cwd: ur?.cwd ?? null, branch: ur?.gitBranch ?? null, sdk: /"sdk-/.test(e ?? "") };
      cache[f] = entry; fresh.set(f, entry);
    }
    onPart?.(all());
  }
  setShared(CACHE, { ...(shared(CACHE) ?? {}), ...Object.fromEntries([...fresh]) });
  // Antigravity and Codex: one read of their files, the whole list kept for the next time.
  const r = await exec("sh", ["-c", OTHERS], { timeout: 20000 }).catch(() => null);
  if (r?.code === 0) {
    const list = (r.stdout ?? "").split("\n").map(parse).filter((x) => x?.id);
    setShared("vnh.sessions.others", list);
    const mine = list.filter((x) => inRepo(x, root));
    return claude().concat(mine).sort((a, b) => b.m - a.m);
  }
  return all();
}

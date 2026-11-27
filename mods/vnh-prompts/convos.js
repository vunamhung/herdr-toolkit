// The conversations of one repository, for the Timeline panel's list: Claude Code, Antigravity and Codex.
// Uses the shared Python reader (`lib/sessions.py`) and the same shared caches as the Ctrl+I popup (vnh-sessions).
import { exec, shared, setShared, appHome } from "herdr";

export const AGENT_ICON = { claude: "icons/claude.svg", agy: "icons/antigravity.svg", codex: "icons/codex.svg" };
const CACHE = "vnh.sessions.cache.v2";
const SESSIONS_PY = () => `${appHome()}/lib/sessions.py`;
const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

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
  const l = await exec("python3", ["-I", SESSIONS_PY(), "list-claude", "--limit", "300", "--slug", slug], { timeout: 15000 }).catch(() => null);
  const files = l?.code === 0 ? (parse(l.stdout)?.files ?? []).map(([m, f]) => ({ m: Number(m), f })) : null;
  const fresh = new Map(), stale = [];
  if (files) {
    for (const { m, f } of files) { const old = cache[f]; if (old && old.m === m) fresh.set(f, old); else stale.push({ m, f }); }
  }
  const claude = () => {
    const byFile = files ? new Map(fresh) : new Map(Object.entries(cache));
    for (const x of stale) if (!byFile.has(x.f) && cache[x.f]) byFile.set(x.f, cache[x.f]);
    return [...byFile.values()].filter((x) => !x.sdk && inRepo(x, root));
  };
  const others = (shared("vnh.sessions.others") ?? []).filter((x) => inRepo(x, root));
  const all = () => claude().concat(others).sort((a, b) => b.m - a.m);
  onPart?.(all());
  for (let i = 0; i < stale.length; i += 24) {
    const batch = stale.slice(i, i + 24);
    const r = await exec("python3", ["-I", SESSIONS_PY(), "read-claude", ...batch.map((x) => x.f)], { timeout: 60000 }).catch(() => null);
    if (r?.code === 0) {
      for (const entry of (r.stdout ?? "").split("\n").map(parse).filter((x) => x?.f)) {
        cache[entry.f] = entry; fresh.set(entry.f, entry);
      }
      onPart?.(all());
    }
  }
  if (files) setShared(CACHE, { ...(shared(CACHE) ?? {}), ...Object.fromEntries([...fresh]) });
  const r = await exec("python3", ["-I", SESSIONS_PY(), "list-others"], { timeout: 20000 }).catch(() => null);
  if (r?.code === 0) {
    const list = (r.stdout ?? "").split("\n").map(parse).filter((x) => x?.id);
    setShared("vnh.sessions.others", list);
    const mine = list.filter((x) => inRepo(x, root));
    return claude().concat(mine).sort((a, b) => b.m - a.m);
  }
  return all();
}

// Directory listing, search indexing, and pure git status/numstat parsers for vnh-filetree.
import { exec, home, window } from "herdr";

export const NAME = "vnh-filetree";
export const PER_FOLDER = 2000;
export const PRUNE = [".git", "node_modules", "target", ".venv", "__pycache__", "dist", ".next"];
export const HOME_PRUNE = ["Library", "AppData", ".Trash"];
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const RANK = { "?": 1, A: 2, C: 2, R: 3, T: 3, M: 3, D: 4, U: 5 };

export const dirOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
export const baseOf = (path) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
export const join = (root, rel) => (rel ? (/[\\/]$/.test(root) ? root + rel : `${root}/${rel}`) : root);
export const stronger = (a, b) => (!a ? b : (RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);
export const windows = (on) => !on && window()?.platform === "windows";
const psQuote = (s) => "'" + s.replaceAll("'", "''") + "'";

export function ancestors(rel) {
  const out = [];
  for (let d = dirOf(rel); d; d = dirOf(d)) out.push(d);
  return out;
}

export function relTo(root, abs) {
  if (!root || !abs) return null;
  const a = abs.replace(/\\/g, "/"), r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (a === r) return "";
  return a.startsWith(r + "/") ? a.slice(r.length + 1) : null;
}

// Natural order, case-insensitive ("file2" before "file10"); this runtime has no Intl.
export const collator = {
  compare(a, b) {
    const x = a.toLowerCase().match(/\d+|\D+/g) ?? [], y = b.toLowerCase().match(/\d+|\D+/g) ?? [];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] === y[i]) continue;
      const nx = /^\d/.test(x[i]), ny = /^\d/.test(y[i]);
      if (nx && ny) return Number(x[i]) - Number(y[i]) || x[i].length - y[i].length;
      return x[i] < y[i] ? -1 : 1;
    }
    return x.length - y.length || (a < b ? -1 : a > b ? 1 : 0);
  },
};

export const sortEntries = (list) => list.sort((a, b) => Number(b.dir) - Number(a.dir) || collator.compare(a.name, b.name));

export async function listDir(path, on) {
  if (windows(on)) {
    const r = await exec("powershell", ["-NoProfile", "-Command", `& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First ${PER_FOLDER + 1} | ForEach-Object { $rp = [bool]($_.Attributes -band [IO.FileAttributes]::ReparsePoint); @{ name=$_.Name; dir=($_.PSIsContainer -and -not $rp); link=$rp; size=$(if ($_.PSIsContainer) {0} else {$_.Length}); mtime=[DateTimeOffset]::new($_.LastWriteTimeUtc).ToUnixTimeMilliseconds() } }) | ConvertTo-Json -Compress } ${psQuote(path)}`]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const raw = JSON.parse(r.stdout || "[]"), list = Array.isArray(raw) ? raw : [raw];
    return { entries: sortEntries(list.slice(0, PER_FOLDER)), more: list.length > PER_FOLDER };
  }
  // Portable single-pass listing avoiding O(N^2) `set -- "$@" "$p"` copies on large folders.
  const runScript = `cd -- "$1" 2>/dev/null || exit 3; fmt="f"; stat -c %s . >/dev/null 2>&1 && fmt="c"; n=0; for p in * .[!.]* ..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; [ "$p" = .git ] && continue; printf '%s\\0' "$p"; n=$((n+1)); [ $n -gt ${PER_FOLDER} ] && break; done | if [ "$fmt" = c ]; then xargs -0 -r stat -c '%F/%s/%Y/%n' -- 2>/dev/null; else xargs -0 sh -c '[ $# -gt 0 ] && stat -f "%HT/%z/%m/%N" -- "$@"' _ 2>/dev/null; fi; exit 0`;
  const r = await exec("sh", ["-c", runScript, NAME, path], { on });
  if (r.code === 3) throw new Error("Cannot open this folder");
  const list = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^([^/]*)\/(\d+)\/(\d+)\/(.+)$/.exec(line);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    list.push({ name: m[4], dir: kind === "directory", link: kind.includes("link"), size: Number(m[2]), mtime: Number(m[3]) * 1000 });
  }
  return { entries: sortEntries(list.slice(0, PER_FOLDER)), more: list.length > PER_FOLDER };
}

export async function buildIndex(root, on) {
  const atHome = root === home() || root === "/";
  const depth = atHome ? 5 : 12;
  if (windows(on)) {
    const r = await exec("powershell", ["-NoProfile", "-Command", `& { param($p) $b = (Resolve-Path -LiteralPath $p).Path.TrimEnd('\\'); Get-ChildItem -LiteralPath $b -Recurse -Force -Depth ${depth} -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '[\\\\/](\\.git|node_modules|target|\\.venv|__pycache__|dist|\\.next)([\\\\/]|$)' } | Select-Object -First 40000 | ForEach-Object { $(if ($_.PSIsContainer) {'d'} else {'f'}) + ($_.FullName.Substring($b.Length + 1) -replace '\\\\', '/') } } ${psQuote(root)}`]);
    const dirs = new Set(), all = [];
    for (const line of r.stdout.split(/\r?\n/)) if (line.length > 1) { const rel = line.slice(1); all.push(rel); if (line[0] === "d") dirs.add(rel); }
    return { dirs, all };
  }
  const names = [...PRUNE, ...(atHome ? HOME_PRUNE : [])].map((n) => `-name '${n}'`).join(" -o ");
  // Single `find` walk printing both directories and files (`d./path` vs `f./path`).
  const script = `cd -- "$1" || exit 3; find . -maxdepth ${depth} \\( ${names} \\) -prune -o \\( -type d -exec printf 'd%s\\n' {} + -o ! -type d -exec printf 'f%s\\n' {} + \\) 2>/dev/null | head -n 45000`;
  const r = await exec("sh", ["-c", script, NAME, root], { on });
  const dirs = new Set(), all = [];
  for (const line of r.stdout.split("\n")) {
    if (line.length < 4 || line.slice(1, 3) !== "./") continue;
    const rel = line.slice(3);
    all.push(rel);
    if (line[0] === "d") dirs.add(rel);
  }
  return { dirs, all };
}

export const emptyGit = () => ({ top: "", prefix: "", branch: null, status: new Map(), files: new Map(), ignored: new Set(), untracked: new Set(), diff: new Map(), counts: new Map() });

export function parseBranch(record) {
  const body = record.replace(/^## /, "");
  if (body.startsWith("HEAD (no branch)")) return { head: "detached", upstream: "", ahead: 0, behind: 0 };
  return {
    head: body.match(/^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.|\s|$)/)?.[1] ?? body,
    upstream: body.match(/\.\.\.(\S+)/)?.[1] ?? "",
    ahead: Number(body.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(body.match(/behind (\d+)/)?.[1] ?? 0),
  };
}

export function parseStatus(stdout, git) {
  const map = (p) => (p.startsWith(git.prefix) ? p.slice(git.prefix.length).replace(/\/$/, "") : null);
  const up = (rel, fn) => { for (const d of [...ancestors(rel), ""]) fn(d); };
  for (const rec of stdout.split("\0")) {
    if (rec.startsWith("## ")) { git.branch = parseBranch(rec); continue; }
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2), raw = rec.slice(3), rel = map(raw);
    if (!rel) continue;
    if (xy === "!!") { if (git.ignored.size < 5000) git.ignored.add(rel); continue; }
    const change = xy === "??" || (xy.includes("A") && !xy.includes("D")) ? 0 : xy.includes("D") && !xy.includes("U") ? 2 : 1;
    if (xy === "??" && raw.endsWith("/")) git.untracked.add(rel);
    else git.files.set(rel, change);
    up(rel, (d) => { const c = git.counts.get(d) ?? [0, 0, 0]; c[change]++; git.counts.set(d, c); });
    const letter = xy === "??" ? "?" : /U/.test(xy) || xy === "AA" || xy === "DD" ? "U" : ["D", "M", "R", "C", "A", "T"].find((c) => xy.includes(c)) ?? "";
    if (!letter) continue;
    git.status.set(rel, stronger(git.status.get(rel), letter));
    up(rel, (d) => git.status.set(d, stronger(git.status.get(d), letter)));
  }
}

export function parseNumstat(stdout, git) {
  for (const rec of stdout.split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
    if (!m || !m[3].startsWith(git.prefix)) continue;
    const rel = m[3].slice(git.prefix.length), add = Number(m[1]) || 0, del = Number(m[2]) || 0;
    for (const d of [rel, ...ancestors(rel), ""]) { const v = git.diff.get(d) ?? [0, 0]; git.diff.set(d, [v[0] + add, v[1] + del]); }
  }
}

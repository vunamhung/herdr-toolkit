// Pure helpers for the Files panel: where to look, listing folders in batches, git decorations,
// formatting and search. No view state here.
import { spaces, panes, focused, exec, shared, setShared, window } from "herdr";

// ---------------------------------------------------------------- where the panel looks

// The folder the focused work happens in. A mod pane (the Markdown viewer, …) has none, and a
// space's starting folder can be another project: fall back to the last terminal folder focused
// in this space (shared "vnh.lastCwd", kept by vnh-files), then the space's first terminal, then
// its starting folder.
export function workFolder(space, f) {
  if (!space) return null;
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane?.terminal && pane.cwd) return pane.cwd;
  if (f && f.pane === null && f.terminal && f.cwd) return f.cwd; // a layout terminal block
  const last = (shared("vnh.lastCwd") ?? {})[space.id];
  if (last) return last;
  const tabs = new Set(space.tabs.map((t) => t.id)), active = space.tabs.find((t) => t.active)?.id;
  const terms = panes().filter((p) => p.terminal && p.cwd && tabs.has(p.tab));
  return (terms.find((p) => p.tab === active) ?? terms[0])?.cwd ?? space.folder ?? null;
}

export function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: workFolder(space, f), on, space: space?.id };
}
export const locationKey = () => JSON.stringify(location());

// Remember the focused terminal's folder per space, for mod panes and the other VNH mods.
export function rememberWorkFolder() {
  const space = spaces().find((s) => s.active), f = focused();
  if (!space || !f) return;
  const pane = f.pane ? panes().find((p) => p.pane === f.pane) : null;
  const cwd = pane?.terminal ? pane.cwd : (f.pane === null && f.terminal ? f.cwd : null);
  if (!cwd) return;
  const map = shared("vnh.lastCwd") ?? {};
  if (map[space.id] !== cwd) setShared("vnh.lastCwd", { ...map, [space.id]: cwd });
}

// ---------------------------------------------------------------- limits and formats

export const PER_FOLDER = 1000, TOTAL = 20000, EXPAND_FOLDERS = 200, CHUNK = 1500;
export const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
export const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;
export const MARKDOWN = /\.(md|markdown|mdx)$/i;

export const ext = (name) => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1).toLowerCase() : ""; };
export const base = (p) => p.slice(p.lastIndexOf("/") + 1);
export const parent = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

// "980 B" / "12.3 KB" / "4.0 MB".
export function fmtSize(n) {
  if (!(n >= 0)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return i === 0 ? `${n} B` : `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// A folder's first-level contents: "3 folders · 12 files".
export function fmtCounts(dirs, files) {
  const part = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return [dirs ? part(dirs, "folder", "folders") : "", files ? part(files, "file", "files") : ""].filter(Boolean).join(" · ") || "empty";
}

// "now" / "4m" / "2h" / "3d" since unix seconds.
export function ago(sec) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// A theme color with alpha (theme colors are #rrggbb[aa]).
export function alpha(color, a) {
  if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}/.test(color)) return color;
  const b = color.length >= 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1;
  return color.slice(0, 7) + Math.round(Math.max(0, Math.min(1, a * b)) * 255).toString(16).padStart(2, "0");
}

// ---------------------------------------------------------------- sorting

export const SORTS = [["name", "Sort by Name"], ["type", "Sort by Type"], ["mtime", "Sort by Modification Time"]];

// Folders first, then by the chosen key; ties by name.
export function sortEntries(list, by) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  return list.sort((a, b) => Number(b.dir) - Number(a.dir)
    || (by === "type" && !a.dir ? ext(a.name).localeCompare(ext(b.name)) : 0)
    || (by === "mtime" ? (b.mtime ?? 0) - (a.mtime ?? 0) : 0)
    || byName(a, b));
}

// ---------------------------------------------------------------- git

// Decorations as in VS Code: U untracked, A added, M modified, D deleted, ! conflict.
// A folder takes the most severe status below it.
export const SEVERITY = { "!": 5, M: 4, D: 3, A: 2, U: 1 };
export function gitMark(xy) {
  if (xy === "??") return "U";
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "!";
  if (xy[0] === "A") return "A";
  if (xy.includes("D")) return "D";
  return "M";
}
export function markColor(t, mark) {
  return mark === "U" || mark === "A" ? t.ansi2 : mark === "M" ? t.ansi3 : mark === "D" || mark === "!" ? t.ansi1 : null;
}

// `git status --porcelain=v1 -z` → { marks: {abs: mark}, folderMarks: {absDir: mark} }.
export function parseStatus(stdout, repo) {
  const marks = {}, folderMarks = {};
  for (const entry of stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
    const mark = gitMark(entry.slice(0, 2));
    let file = `${repo}/${entry.slice(3)}`;
    if (file.endsWith("/")) file = file.slice(0, -1); // an untracked folder shown as one entry
    marks[file] = mark;
    for (let dir = file.slice(0, file.lastIndexOf("/")); dir.length > repo.length; dir = dir.slice(0, dir.lastIndexOf("/"))) {
      if ((SEVERITY[folderMarks[dir]] ?? 0) >= SEVERITY[mark]) break;
      folderMarks[dir] = mark;
    }
  }
  return { marks, folderMarks };
}

// `git diff -U0` hunks as change markers: added / modified line ranges (1-based, in the working
// file) and "deleted" points (lines removed after line `start`).
export function parseHunks(diff) {
  const out = [];
  for (const line of diff.split("\n")) {
    const m = line.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const oldCount = m[1] === undefined ? 1 : Number(m[1]);
    const start = Number(m[2]), count = m[3] === undefined ? 1 : Number(m[3]);
    if (count === 0) out.push({ kind: "deleted", start, count: 0 });
    else out.push({ kind: oldCount === 0 ? "added" : "modified", start, count });
  }
  return out;
}

// A unified diff as display lines: { kind: "add" | "del" | "hunk" | "ctx", text, old, new }.
export function diffLines(diff) {
  const out = [];
  let oldNo = 0, newNo = 0, body = false;
  for (const line of diff.split("\n")) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); body = true; out.push({ kind: "hunk", text: line }); continue; }
    if (!body) continue; // diff --git / index / --- / +++ headers
    if (line === "") continue; // the output's final newline (context lines start with a space)
    if (line.startsWith("+")) out.push({ kind: "add", text: line.slice(1), new: newNo++ });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line.slice(1), old: oldNo++ });
    else if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    else out.push({ kind: "ctx", text: line.slice(1), old: oldNo++, new: newNo++ });
  }
  return out;
}

export const git = (cwd, on, args) =>
  exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", ...args], { cwd, on }).catch(() => null);

// ---------------------------------------------------------------- listing

// Lists several folders with ONE shell call (plus one `stat` call when sizes or times are shown),
// so the work per refresh does not grow with the number of open folders.
// Returns Map<absolute folder, entries | null (missing)>.
const LIST_SCRIPT = 'sz=$1; shift; for root in "$@"; do printf "\\001%s\\0" "$root"; [ -d "$root" ] || { printf "\\002\\0"; continue; }; n=0; for p in "$root"/* "$root"/.[!.]* "$root"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; info=; if [ -d "$p" ]; then kind=d; if [ "$sz" = 1 ]; then d=0; f=0; for q in "$p"/* "$p"/.[!.]* "$p"/..?*; do [ -e "$q" ] || [ -L "$q" ] || continue; [ "${q##*/}" = .git ] && continue; if [ -d "$q" ]; then d=$((d+1)); else f=$((f+1)); fi; done; info="$d $f"; fi; else kind=f; fi; printf "%s\\0%s\\0%s\\0" "$kind" "$name" "$info"; n=$((n+1)); [ "$n" -gt 1000 ] && break; done; done';
// "size mtime path" per line; GNU or BSD stat, whichever this machine has.
const STAT_SCRIPT = 'if stat -c %s / >/dev/null 2>&1; then stat -c "%s %Y %n" -- "$@"; else stat -f "%z %m %N" -- "$@"; fi 2>/dev/null; true';

// Windows (local) folders, one at a time: PowerShell.
async function windowsDirectory(path, on) {
  const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 1001 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const result = JSON.parse(r.stdout || "[]");
  return Array.isArray(result) ? result : [result];
}

// "size mtime" by absolute path, one `stat` per CHUNK paths.
export async function statPaths(paths, on) {
  const byPath = new Map();
  for (let k = 0; k < paths.length; k += CHUNK) {
    const st = await exec("sh", ["-c", STAT_SCRIPT, "stat", ...paths.slice(k, k + CHUNK)], { on }).catch(() => null);
    for (const line of (st?.stdout ?? "").split("\n")) {
      const a = line.indexOf(" "), b = line.indexOf(" ", a + 1);
      if (a > 0 && b > a) byPath.set(line.slice(b + 1), { size: Number(line.slice(0, a)), mtime: Number(line.slice(a + 1, b)) });
    }
  }
  return byPath;
}

export async function listFolders(paths, on, sizes, mtimes) {
  const out = new Map();
  if (!paths.length) return out;
  const oneByOne = async () => { for (const p of paths) out.set(p, await windowsDirectory(p, on).catch(() => null)); return out; };
  if (!on && window()?.platform === "windows") return oneByOne();
  let r;
  try { r = await exec("sh", ["-c", LIST_SCRIPT, "files", sizes ? "1" : "0", ...paths], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return oneByOne();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0");
  let cur = null;
  for (let i = 0; i < fields.length;) {
    const f = fields[i];
    if (f.startsWith("\x01")) { cur = f.slice(1); out.set(cur, []); i++; continue; }
    if (f === "\x02") { if (cur !== null) out.set(cur, null); i++; continue; }
    if (cur === null || i + 2 >= fields.length) break;
    const entry = { name: fields[i + 1], dir: f === "d" }, info = fields[i + 2];
    if (info && entry.dir) { const [d, n] = info.split(" ").map(Number); entry.counts = { dirs: d || 0, files: n || 0 }; }
    out.get(cur)?.push(entry);
    i += 3;
  }
  if (sizes || mtimes) {
    const want = [];
    for (const [dir, list] of out) for (const e of list ?? []) if (mtimes || !e.dir) want.push([`${dir}/${e.name}`, e]);
    const st = await statPaths(want.map(([p]) => p), on);
    for (const [p, e] of want) {
      const v = st.get(p);
      if (!v) continue;
      if (sizes && !e.dir) e.size = v.size;
      if (mtimes) e.mtime = v.mtime;
    }
  }
  return out;
}

// ---------------------------------------------------------------- search

// Every file below `root` for name search: git's tracked + untracked-not-ignored files, else
// `find` without .git and node_modules. Paths relative to root; at most 100k.
export async function listAllFiles(root, on, inRepo) {
  if (inRepo) {
    const r = await git(root, on, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (r?.code === 0) return [...new Set(r.stdout.split("\0").filter(Boolean))].slice(0, 100000);
  }
  const r = await exec("sh", ["-c", 'cd "$1" && find . \\( -name .git -o -name node_modules \\) -prune -o -type f -print 2>/dev/null | head -100000', "find", root], { on }).catch(() => null);
  return (r?.stdout ?? "").split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, ""));
}

// Files whose path contains every word of the query (case-insensitive); names that match the
// first word rank first, then shorter paths. At most `limit`.
export function searchFiles(files, query, limit = 500) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const p of files) {
    const lower = p.toLowerCase();
    if (!words.every((w) => lower.includes(w))) continue;
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    const score = (name.startsWith(words[0]) ? 0 : name.includes(words[0]) ? 1 : 2) * 1000 + p.length;
    hits.push([score, p]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  return hits.slice(0, limit).map(([, p]) => p);
}

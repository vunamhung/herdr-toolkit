// Derived from `filetree` of cybertron288/herdr-mods (itself a port of data-goblin/claude-code-filetree, MIT, Kurt Buhler) (MIT, herdr-mods (filetree), cybertron288, https://github.com/cybertron288/herdr-mods); modified for herdr-toolkit. See THIRD-PARTY-NOTICES.md.
// filetree: an IDE-style file tree for any Herdr layout. A port of claude-code-filetree
// (MIT, Kurt Buhler): git status with line and file counts, a branch row, search across
// unopened folders, date or size column, keyboard navigation, previews, and Claude's reads,
// writes and git actions shimmering in the tree (fed by mods/vnh-filetree/bridge.ts).
// Layout-neutral: colors come from theme(), corners and header height from the shown
// layout's pane frame, fonts from settings().
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle, TextView } from "gpui-base";
import ICONS from "./icons.js"; // copied from the file-icons mod (mods cannot import across folders)
import { spaces, panes, agents, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, layout, home, appHome, props, run, notify, openOverlay, closeOverlay, shared, setShared, nextCommand, hc } from "herdr";

const NAME = "vnh-filetree"; // VNH clone of filetree (the hook bridge stays in mods/filetree)
const ICON = (name) => `mods/${NAME}/${name}.svg`;
// VNH: a file in Helix, in a tab of its own, started in the project's root (not in the file's folder: the tab's folder is what the other
// panels follow): Space on a file, or a press on the blank after its name (see onEye). hx-open.py starts it so that Esc quits
// Helix, shows the tab you came from again and closes this one.
async function openInHelix(abs, on, root) {
  if (on) { notify({ title: "Helix opens the files of this computer only", level: "info", timeout: 3000 }); return; }
  const space = spaces().find((s) => s.active);
  if (!space || !abs) return;
  // One Helix tab per space: when it is running (hx-open.py registers it), the file is opened in it (Alt-o there is `:open` of the path
  // written to open-<terminal>) and its tab is shown; else a tab is started.
  try {
    const reg = JSON.parse((await readTextFile(`${home()}/.cache/vnh-hx/registry.json`).catch(() => null)) ?? "{}");
    const term = reg[space.id], pane = term ? panes().find((p) => p.terminal === term) : null;
    if (pane) {
      await writeTextFile(`${home()}/.cache/vnh-hx/open-${term}`, abs);
      await exec("sh", ["-c", 'exec "$HOME/.local/bin/hc" keys "$1" alt+o', "x", term]);
      run("tab.select", { id: pane.tab });
      return;
    }
  } catch {}
  const back = space.tabs.find((t) => t.active)?.id ?? "";
  run("tab.new", { space: space.id, folder: root || abs.slice(0, abs.lastIndexOf("/")) || "/", name: abs.split("/").pop().slice(0, 40),
    argv: ["sh", "-lc", 'exec python3 -I "$1" "$2" "$3" "$4"', "hx", `${appHome()}/mods/vnh-filetree/hx-open.py`, abs, back, String(theme().background ?? "")] });
}
// VNH: Markdown is previewed from inside Helix (Space m, see hx-open.py), which opens it as a rendered tab (vnh-markdown).
const MARKDOWN = /\.(md|markdown|mdx)$/i;
// VNH: the space's Markdown tab, reused for every preview: ask it to switch (shared
// "vnh.markdown.open", read by that pane's copy) and show it; open one only when there is none.
function openMarkdownTab(path, on) {
  const space = spaces().find((s) => s.active);
  if (!space || !path) return;
  const ids = new Set(space.tabs.map((t) => t.id)), current = space.tabs.find((t) => t.active)?.id ?? null;
  const md = panes().find((p) => p.mod === "vnh-markdown" && ids.has(p.tab));
  if (md) {
    setShared("vnh.markdown.open", { pane: md.pane, path, on: on ?? null, back: current !== md.tab ? current : null, n: Date.now() });
    run("tab.select", { id: md.tab });
  } else {
    run("tab.new", { space: space.id, name: path.split("/").pop(), mod: "vnh-markdown", props: { path, on: on ?? null, back: current } });
  }
}

// Width of a character of the 13 px UI font: PragmataPro is narrow (0.5 em, 6.5 px, checked on screen),
// the other monospaced UI fonts Herdr ships about 0.6 em.
const charWidth = () => (/pragmata/i.test(String(settings().ui_font ?? "")) ? 6.5 : 7.8);
const ROW = 26;
const PER_FOLDER = 2000;
const FIND_LIMIT = 200;
const FLASH_MS = 2700, TINT_MS = 45000, RUNNING_MS = 600000, CHIP_MS = 45000;
const READ_REVEAL = 12, SEARCH_REVEAL = 60;
const PRUNE = [".git", "node_modules", "target", ".venv", "__pycache__", "dist", ".next"];
const HOME_PRUNE = ["Library", "AppData", ".Trash"];
const DEFAULTS = { activity: "reads and writes", follow: true, column: "date", open: "preview" };
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie): the folder
// watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", svelte: "html", vue: "html", htm: "html", sh: "bash", zsh: "bash" };
const RANK = { "?": 1, A: 2, C: 2, R: 3, T: 3, M: 3, D: 4, U: 5 };
// Natural order, case-insensitive ("file2" before "file10"); this runtime has no Intl.
const collator = {
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
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── paths ──────────────────────────────────────────────────────────────────────────────
const dirOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const baseOf = (path) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
const join = (root, rel) => (rel ? (/[\\/]$/.test(root) ? root + rel : `${root}/${rel}`) : root);
function ancestors(rel) {
  const out = [];
  for (let d = dirOf(rel); d; d = dirOf(d)) out.push(d);
  return out;
}
function relTo(root, abs) {
  if (!root || !abs) return null;
  const a = abs.replace(/\\/g, "/"), r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (a === r) return "";
  return a.startsWith(r + "/") ? a.slice(r.length + 1) : null;
}
const stronger = (a, b) => (!a ? b : (RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);

// ── formatting ─────────────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes == null || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["K", "M", "G", "T"];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 100 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
function stamp(ms) {
  if (!ms) return "";
  const d = new Date(ms), now = new Date(), p = (v) => String(v).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  const month = MONTHS[d.getMonth()];
  return d.getFullYear() === now.getFullYear() ? `${month} ${d.getDate()}` : `${month} ${d.getFullYear()}`;
}
function words(command) {
  const out = [];
  let word = null, quote = "";
  for (const ch of command) {
    if (quote) { if (ch === quote) quote = ""; else word = (word ?? "") + ch; }
    else if (ch === '"' || ch === "'") { quote = ch; word ??= ""; }
    else if (/\s/.test(ch)) { if (word !== null) out.push(word); word = null; }
    else word = (word ?? "") + ch;
  }
  if (word !== null) out.push(word);
  return out;
}

// ── the active setup's look ────────────────────────────────────────────────────────────
// Corners and header height follow the shown layout's pane frame, so the tree sits in
// whatever layout it is put in: square in a flush layout, rounded in a card layout.
function frameLook() {
  let pane = null;
  const walk = (n) => {
    if (!n || pane) return;
    if (n.content?.tab && n.content.pane) pane = n.content.pane;
    for (const c of n.children ?? []) walk(c);
  };
  try { walk(layout()); } catch {}
  const radius = Number(pane?.radius ?? 6);
  return { radius: Math.max(0, Math.min(6, Number.isFinite(radius) ? radius : 6)), header: Math.max(26, Math.min(40, Number(pane?.header?.height) || 30)) };
}
// A theme color at some opacity, for tinted backgrounds. Themes may give #rgb, #rrggbb or
// #rrggbbaa; anything else is returned as is.
function alpha(color, a) {
  const hex = /^#([0-9a-f]{3})$/i.test(color ?? "") ? "#" + [...color.slice(1)].map((c) => c + c).join("") : color;
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex ?? "")) return color;
  return hex.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0");
}
// Writes are orange (ansi 3), modified is yellow (ansi 11), so the two never read alike.
const tones = (t) => ({ purple: t.ansi5, orange: t.ansi3, green: t.ansi2, teal: t.ansi6, blue: t.ansi4, red: t.ansi1, cyan: t.ansi14 ?? t.ansi6, yellow: t.ansi11 ?? t.ansi3 });
const gitColor = (t, s) => (!s ? null : s === "D" || s === "U" ? t.ansi1 : s === "?" || s === "A" || s === "C" ? t.ansi2 : s === "R" ? t.ansi4 : t.ansi11 ?? t.ansi3);
const KIND = { purple: "read", orange: "write", green: "commit" };
// VNH: Antigravity (agy) has no tool hooks, but it records every step of a conversation in a SQLite file named after the session.
// This reads the steps after the last one seen (read_file, edit_file, write_file: their "Path") and prints one JSON line each.
const AGY_PY = String.raw`
import sqlite3, sys, os, re, json
base = os.path.expanduser("~/.gemini/antigravity-cli/conversations")
for arg in sys.argv[1:]:
    sid, _, last = arg.rpartition(":")
    if not re.fullmatch(r"[0-9a-f-]{36}", sid): continue
    try:
        last = int(last)
        db = sqlite3.connect("file:%s/%s.db?mode=ro" % (base, sid), uri=True, timeout=1)
        rows = db.execute("select idx, status, step_payload from steps where step_type=132 and idx>? order by idx", (last,)).fetchall()
        top = db.execute("select max(idx) from steps").fetchone()[0]
    except Exception:
        continue
    if last < 0:
        print(json.dumps({"session": sid, "max": top if top is not None else -1})); continue
    new = last
    for idx, status, pl in rows:
        if status != 3: break
        new = idx
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
const VIEWS = [["tree", "Tree", "folder"], ["recent", "Recent", "clock"]];
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 10 ? "now" : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}
// File and folder icons: Material Icon Theme, from the file-icons mod (icons.js copied here,
// the SVGs read from its icons/ folder), matched the way VS Code does. Names are compared in lower case; a
// path rule (".github/workflows") beats a name, a name beats an extension, the longest
// extension wins ("spec.ts" over "ts"). Light themes check the light table first.
const ICON_DIR = "mods/file-icons/icons";
const bare = (name) => name.replace(/^__(.+)__$/, "$1").replace(/^[._-]/, "");
const opened = (id) => (id.endsWith("_light") ? `${id.slice(0, -6)}-open_light` : `${id}-open`);
const lookup = (table, key, dark) => (dark ? undefined : ICONS.light[table][key]) ?? ICONS[table][key];
function fileIcon(path, dir, open, dark) {
  const parts = path.toLowerCase().split("/"), name = parts[parts.length - 1];
  const table = dir ? "folderNames" : "fileNames", find = (key) => lookup(table, key, dark) ?? (dir ? lookup(table, bare(key), dark) : undefined);
  let id;
  for (let i = 0; !id && i < parts.length - 1; i++) id = find(parts.slice(i).join("/"));
  if (dir) {
    id ??= find(name) ?? ICONS.folder;
    return `${ICON_DIR}/${open ? opened(id) : id}.svg`;
  }
  id ??= lookup(table, name, dark);
  for (let dot = name.indexOf("."); !id && dot !== -1; dot = name.indexOf(".", dot + 1)) id = lookup("fileExtensions", name.slice(dot + 1), dark);
  return `${ICON_DIR}/${id ?? ICONS.file}.svg`;
}

// ── VNH: more folders in a space (multi-root, as VS Code's "Add Folder to Workspace") ──────
// A folder dropped on the panel joins the active space as another root, listed under the space's
// own folder; right-click a root to remove it. Roots are kept per space in shared FOLDERS. Claude
// sees them too: new agents through the project's .claude/settings.local.json
// (permissions.additionalDirectories, only entries we added are ever removed), idle running ones
// through `/add-dir` (Claude then asks to trust the folder in that agent).
const FOLDERS = "vnh.space.folders";              // { [spaceId]: [absolute folder, …] }
const CLAUDE_DIRS = "vnh.space.folders.claude";   // { [settings file]: [folders we added there] }
const MAX_ROOTS = 8;
// Row keys of the extra roots; the space's own folder keeps plain relative keys.
const keyOf = (rid, rel) => `\u0001${rid}\u0002${rel}`;
const headKey = (rid) => `\u0001${rid}\u0003`;
function parseKey(k) {
  const m = typeof k === "string" ? /^\u0001(\d+)([\u0002\u0003])(.*)$/s.exec(k) : null;
  return m ? { rid: Number(m[1]), head: m[2] === "\u0003", rel: m[3] } : null;
}
const activeSpace = () => spaces().find((s) => s.active) ?? null;

async function claudeDirs(project, add, remove) {
  if (!project || (!add.length && !remove.length)) return;
  const file = `${project}/.claude/settings.local.json`;
  const before = await readTextFile(file).catch(() => null);
  let json = {};
  try { json = before ? JSON.parse(before) : {}; } catch { notify({ title: "Not shared with Claude", body: `${file} is not valid JSON`, level: "warning", timeout: 5000 }); return; }
  if (!before && !add.length) return;
  const mine = new Set((shared(CLAUDE_DIRS) ?? {})[file] ?? []);
  const dirs = new Set(Array.isArray(json.permissions?.additionalDirectories) ? json.permissions.additionalDirectories : []);
  for (const p of add) if (!dirs.has(p)) { dirs.add(p); mine.add(p); }
  for (const p of remove) if (mine.has(p)) { dirs.delete(p); mine.delete(p); }
  const permissions = { ...(json.permissions ?? {}), additionalDirectories: [...dirs] };
  if (!dirs.size) delete permissions.additionalDirectories;
  const next = { ...json, permissions };
  if (!Object.keys(permissions).length) delete next.permissions;
  try {
    await exec("mkdir", ["-p", `${project}/.claude`]);
    await writeTextFile(file, JSON.stringify(next, null, 2) + "\n", before);
    setShared(CLAUDE_DIRS, { ...(shared(CLAUDE_DIRS) ?? {}), [file]: [...mine] });
  } catch (e) { notify({ title: "Not shared with Claude", body: String(e?.message ?? e), level: "warning", timeout: 5000 }); }
}

// Idle Claude agents of the space get `/add-dir <folder>` typed in (hc waits for an unfinished draft).
function tellAgents(spaceId, folders) {
  for (const a of agents()) {
    if (a.space !== spaceId || a.status !== "idle" || a.app !== "claude-code") continue;
    for (const p of folders) hc(["send", "--if", "idle", a.address, `/add-dir ${p}`]).catch(() => {});
  }
}

async function addSpaceFolders(dirs, primary, project) {
  const sp = activeSpace();
  if (!sp) return [];
  const all = shared(FOLDERS) ?? {}, list = [...(all[sp.id] ?? [])], added = [];
  for (let p of dirs) {
    p = p.replace(/\/+$/, "") || "/";
    if (p === primary || list.includes(p)) continue;
    if (list.length >= MAX_ROOTS - 1) { notify({ title: `A space holds at most ${MAX_ROOTS} folders`, level: "warning", timeout: 4000 }); break; }
    list.push(p); added.push(p);
  }
  if (!added.length) return added;
  setShared(FOLDERS, { ...all, [sp.id]: list });
  await claudeDirs(project, added, []);
  tellAgents(sp.id, added);
  notify({ title: added.length > 1 ? `Added ${added.length} folders to ${sp.name}` : `Added ${baseOf(added[0])} to ${sp.name}`, body: "Claude agents in this space can use it too.", level: "success", timeout: 3000 });
  return added;
}

async function removeSpaceFolder(spaceId, path, project) {
  const all = shared(FOLDERS) ?? {}, list = (all[spaceId] ?? []).filter((p) => p !== path);
  setShared(FOLDERS, { ...all, [spaceId]: list });
  await claudeDirs(project, [], [path]);
  notify({ title: `Removed ${baseOf(path)} from the space`, body: "Its files are untouched.", level: "info", timeout: 3000 });
}

// ── where to look ──────────────────────────────────────────────────────────────────────
// The focused pane's folder; when the focused pane is a mod (this tree opened as a pane,
// say), the first terminal beside it.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  let pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && !pane.terminal) pane = panes().find((p) => p.tab === pane.tab && p.terminal && p.cwd) ?? null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // VNH: a tab with no terminal (the Markdown viewer, a mod pane) keeps the folder last worked in
  // (shared "vnh.lastCwd", kept by vnh-tabs) instead of the space's starting folder, which can be
  // another project: the tree stays put instead of reloading.
  const last = !pane?.cwd && !f?.cwd ? (shared("vnh.lastCwd") ?? {})[space?.id] : null;
  return { cwd: pane?.cwd || f?.cwd || last || space?.folder || null, on };
}
const windows = (on) => !on && window()?.platform === "windows";
const psQuote = (s) => "'" + s.replaceAll("'", "''") + "'";

async function listDir(path, on) {
  if (windows(on)) {
    const r = await exec("powershell", ["-NoProfile", "-Command", `& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First ${PER_FOLDER + 1} | ForEach-Object { $rp = [bool]($_.Attributes -band [IO.FileAttributes]::ReparsePoint); @{ name=$_.Name; dir=($_.PSIsContainer -and -not $rp); link=$rp; size=$(if ($_.PSIsContainer) {0} else {$_.Length}); mtime=[DateTimeOffset]::new($_.LastWriteTimeUtc).ToUnixTimeMilliseconds() } }) | ConvertTo-Json -Compress } ${psQuote(path)}`]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const raw = JSON.parse(r.stdout || "[]"), list = Array.isArray(raw) ? raw : [raw];
    return { entries: sortEntries(list.slice(0, PER_FOLDER)), more: list.length > PER_FOLDER };
  }
  // One stat call for the folder: GNU's -c, else BSD's -f. "/" can't be in a name, so it splits.
  const script = `cd "$1" 2>/dev/null || exit 3; set --; for p in * .[!.]* ..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; [ "$p" = .git ] && continue; set -- "$@" "$p"; [ $# -gt ${PER_FOLDER} ] && break; done; [ $# -eq 0 ] && exit 0; if stat -c %s . >/dev/null 2>&1; then stat -c '%F/%s/%Y/%n' -- "$@"; else stat -f '%HT/%z/%m/%N' -- "$@"; fi; exit 0`;
  const r = await exec("sh", ["-c", script, NAME, path], { on });
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
const sortEntries = (list) => list.sort((a, b) => Number(b.dir) - Number(a.dir) || collator.compare(a.name, b.name));

async function buildIndex(root, on) {
  const atHome = root === home() || root === "/";
  const depth = atHome ? 5 : 12;
  if (windows(on)) {
    const r = await exec("powershell", ["-NoProfile", "-Command", `& { param($p) $b = (Resolve-Path -LiteralPath $p).Path.TrimEnd('\\'); Get-ChildItem -LiteralPath $b -Recurse -Force -Depth ${depth} -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '[\\\\/](\\.git|node_modules|target|\\.venv|__pycache__|dist|\\.next)([\\\\/]|$)' } | Select-Object -First 40000 | ForEach-Object { $(if ($_.PSIsContainer) {'d'} else {'f'}) + ($_.FullName.Substring($b.Length + 1) -replace '\\\\', '/') } } ${psQuote(root)}`]);
    const dirs = new Set(), all = [];
    for (const line of r.stdout.split(/\r?\n/)) if (line.length > 1) { const rel = line.slice(1); all.push(rel); if (line[0] === "d") dirs.add(rel); }
    return { dirs, all };
  }
  const names = [...PRUNE, ...(atHome ? HOME_PRUNE : [])].map((n) => `-name '${n}'`).join(" -o ");
  const script = `cd "$1" || exit 3; find . -maxdepth ${depth} \\( ${names} \\) -prune -o -type d -print 2>/dev/null | head -n 20000; echo //; find . -maxdepth ${depth} \\( ${names} \\) -prune -o ! -type d -print 2>/dev/null | head -n 40000`;
  const r = await exec("sh", ["-c", script, NAME, root], { on });
  const dirs = new Set(), all = [];
  let inDirs = true;
  for (const line of r.stdout.split("\n")) {
    if (line === "//") { inDirs = false; continue; }
    if (!line.startsWith("./")) continue;
    const rel = line.slice(2);
    all.push(rel);
    if (inDirs) dirs.add(rel);
  }
  return { dirs, all };
}

// ── git ────────────────────────────────────────────────────────────────────────────────
const emptyGit = () => ({ top: "", prefix: "", branch: null, status: new Map(), files: new Map(), ignored: new Set(), untracked: new Set(), diff: new Map(), counts: new Map() });

function parseBranch(record) {
  const body = record.replace(/^## /, "");
  if (body.startsWith("HEAD (no branch)")) return { head: "detached", upstream: "", ahead: 0, behind: 0 };
  return {
    head: body.match(/^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.|\s|$)/)?.[1] ?? body,
    upstream: body.match(/\.\.\.(\S+)/)?.[1] ?? "",
    ahead: Number(body.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(body.match(/behind (\d+)/)?.[1] ?? 0),
  };
}

function parseStatus(stdout, git) {
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

function parseNumstat(stdout, git) {
  for (const rec of stdout.split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
    if (!m || !m[3].startsWith(git.prefix)) continue;
    const rel = m[3].slice(git.prefix.length), add = Number(m[1]) || 0, del = Number(m[2]) || 0;
    for (const d of [rel, ...ancestors(rel), ""]) { const v = git.diff.get(d) ?? [0, 0]; git.diff.set(d, [v[0] + add, v[1] + del]); }
  }
}

// ── opening files ──────────────────────────────────────────────────────────────────────
async function openExternal(abs) {
  const platform = window()?.platform;
  const r = platform === "macos" ? await exec("open", ["--", abs])
    : platform === "windows" ? await exec("powershell", ["-NoProfile", "-Command", `Invoke-Item -LiteralPath ${psQuote(abs)}`])
    : await exec("xdg-open", [abs]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "No app opens this file");
}
async function revealExternal(abs) {
  const platform = window()?.platform;
  if (platform === "macos") await exec("open", ["-R", "--", abs]);
  else if (platform === "windows") await exec("explorer.exe", [`/select,${abs.replace(/\//g, "\\")}`]);
  else await exec("xdg-open", [abs.replace(/\/[^/]*$/, "") || "/"]);
}
function copy(cx, text) {
  cx.write_to_clipboard(text);
  notify({ title: "Copied", body: text, level: "info", timeout: 2000 });
}
// Types "@path " into the agent of the shown tab, through the clipboard, then puts the
// clipboard back. The agent's pane takes the keyboard so the question can follow.
function sendToAgent(cx, abs) {
  const f = focused(), fp = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const inTab = agents().filter((a) => a.tab === f?.tab);
  const address = (fp?.status && fp.terminal) || (inTab.find((a) => a.focused) ?? inTab[0])?.address || agents().find((a) => a.focused)?.address;
  if (!address) { notify({ title: "No agent in this tab", body: "Start one, then send the path again", level: "warning", timeout: 3000 }); return; }
  const cwd = panes().find((p) => p.terminal === address)?.cwd;
  const rel = relTo(cwd, abs), path = rel || abs;
  const text = `@${/\s/.test(path) ? `"${path}"` : path} `;
  const before = cx.read_from_clipboard();
  cx.write_to_clipboard(text);
  run("pane.focus", { terminal: address });
  run("terminal.paste");
  cx.timer.after(600, (cx) => { if (before !== undefined) cx.write_to_clipboard(before); });
}

export default class FileTree extends View {
  init(_props, cx) {
    this.menu = props()?.menu ?? null;
    if (this.menu) return;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.config = { ...DEFAULTS };
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem("prefs") ?? "{}"); } catch {}
    this.showHidden = prefs.showHidden ?? true;
    this.showIgnored = prefs.showIgnored ?? true; // VNH: git-ignored files and folders (⊘ button, i)
    this.showSize = prefs.showSize ?? null;
    this.follow = true; this.pinned = null;
    this.view = VIEWS.some(([v]) => v === prefs.view) ? prefs.view : "tree";
    try { this.history = JSON.parse(localStorage.getItem("history") ?? "[]"); } catch { this.history = []; }
    this.agoAt = 0;
    // VNH: Recent and the follow-scroll belong to the agent you are looking at (its Claude session), not to every agent in the repo.
    this.mine = null; this.mineKey = ""; this.mineAt = 0;
    this.agyLast = new Map(); this.agyBusy = false;
    // VNH: the files each agent session wrote, published for the Changes panel's "only this session's files".
    this.sessionFiles = new Map(); this.filesDirty = false;
    for (const h of this.history) if (h.session && h.kind === "write") { if (!this.sessionFiles.has(h.session)) this.sessionFiles.set(h.session, new Set()); this.sessionFiles.get(h.session).add(h.abs); }
    this.filesDirty = this.sessionFiles.size > 0;
    try { this.allAgents = localStorage.getItem("allAgents") === "1"; } catch { this.allAgents = false; }
    this.saved = new Map(); this.flashes = new Map(); this.bashStarts = new Map(); this.recent = [];
    this.sizes = new Map(); this.sizing = new Set(); this.visible = [];
    this.chip = null; this.branchFlash = null; this.width = 320; this.query = ""; this.hits = null; this.searchSeq = 0;
    this.seenAt = Date.now() - 2000; this.seenPreview = shared(`${NAME}.preview`)?.n ?? 0; this.seenView = shared(`${NAME}.view`)?.n ?? 0;
    this.input = InputState.new({ placeholder: "Filter files" });
    this.input.on("change", (_e, cx) => this.search(this.input.value(), cx));
    this.input.on("submit", (_e, cx) => this.jump(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.reset(null, null);
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${appHome()}/mods/${NAME}/config.json`);
        if (text) this.config = { ...DEFAULTS, ...JSON.parse(text) };
      } catch (e) { notify({ title: "filetree: config.json is invalid", body: String(e), level: "warning", timeout: 4000 }); }
      this.showSize ??= this.config.column === "size";
      cx.notify();
    });
    this.watchActivity(cx);
    // VNH: no reads while the side panel hides the tree; it catches up when it shows.
    cx.timer.every(10000, (cx) => { if (this.shownNow()) this.refreshAll(cx); else this.stale = true; });
    cx.timer.every(1000, (cx) => { if (this.stale && this.shownNow()) { this.stale = false; this.refreshAll(cx); } });
    // "filetree.focus": the Markdown tab hands the keyboard back here when it closes.
    cx.spawn(async (cx) => { for (;;) { if (String(await nextCommand()).replace(/^filetree\./, "") === "focus") this.handle?.focus(); cx.notify(); } });
    cx.timer.every(1000, (cx) => this.tick(cx));
    cx.timer.every(2000, (cx) => this.pollAgy(cx)); // VNH: agy's reads and writes
  }

  // agy's reads and writes, from its conversation files (see AGY_PY): lit in the tree and listed in Recent like Claude's, per session.
  async pollAgy(cx) {
    if (this.agyBusy) return;
    this.agyBusy = true;
    try {
      const sessions = new Set();
      for (const a of agents()) {
        const text = await readTextFile(`${home()}/.cache/herdr-status/${a.address}.json`).catch(() => null);
        try { const j = JSON.parse(text ?? "{}"); if (j.provider === "agy" && j.session) sessions.add(j.session); } catch {}
      }
      for (const sid of [...this.agyLast.keys()]) if (!sessions.has(sid)) this.agyLast.delete(sid);
      if (!sessions.size) return;
      const r = await exec("python3", ["-I", "-c", AGY_PY, ...[...sessions].map((sid) => `${sid}:${this.agyLast.get(sid) ?? -1}`)]).catch(() => null);
      if (!r || r.code !== 0) return;
      const mode = this.config.activity, reads = mode === "reads and writes" || mode === "reads", writes = mode === "reads and writes" || mode === "writes";
      for (const line of r.stdout.split("\n")) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.max != null) this.agyLast.set(e.session, e.max);
        else if (e.kind === "read" && reads) this.flash([e.path], "purple", cx, READ_REVEAL, e.session);
        else if (e.kind === "write" && writes) this.flash([e.path], "orange", cx, READ_REVEAL, e.session);
      }
    } finally { this.agyBusy = false; }
  }

  // VNH: on screen? Only while the layout's side panel shows this block; anywhere else always.
  shownNow() {
    const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).reduce((hit, c) => hit ?? find(c, id), null));
    const root = layout(), body = find(root, "panel-body"), panel = find(root, "panel");
    const block = body?.children?.find((c) => c.content?.mod === NAME);
    if (!block) return true;
    return Boolean(panel && !panel.hidden && body.active === block.id);
  }

  // VNH: a rendered Markdown tab; Esc or Space there closes it and comes back to the tab it came from.
  openMarkdown(rel) {
    if (!rel || !this.root) return;
    if (rel === this.file && this.fileAbs) { openMarkdownTab(this.fileAbs, null); return; }
    openMarkdownTab(join(this.root, rel), this.on);
  }

  savePrefs() {
    try { localStorage.setItem("prefs", JSON.stringify({ showHidden: this.showHidden, showIgnored: this.showIgnored, showSize: this.showSize, view: this.view })); } catch {}
  }

  setView(view, cx) {
    if (view === this.view) return;
    this.view = view;
    this.savePrefs();
    this.hits = null; this.searchSeq++;
    if (view === "tree" && this.query.trim()) this.search(this.query, cx);
    this.scrollTo = this.cursor || null;
    cx.notify();
  }

  // ── the folder shown ─────────────────────────────────────────────────────────────────
  wanted() {
    const loc = location();
    if (!this.follow && this.pinned) return { root: this.pinned, on: this.pinnedOn };
    return { root: loc.cwd, on: loc.on };
  }

  reset(root, on) {
    if (this.ctx?.root) this.saved.set(this.ctx.key, { folders: this.folders, cursor: this.cursor });
    const key = JSON.stringify([root, on]), s = this.saved.get(key);
    this.ctx = { key, root, on }; this.root = root; this.on = on;
    this.entries = new Map(); this.folders = new Set(s?.folders); this.pending = new Set();
    this.cursor = s?.cursor ?? ""; this.git = emptyGit(); this.index = null; this.hits = null;
    this.sizes = new Map(); this.sizing = new Set(); this.error = null; this.limited = false;
    this.loading = false; this.again = false; this.watched = null; this.scrollTo = this.cursor || null;
    if (this.query) { this.query = ""; this.input?.set_value(""); }
    this.closePreview();
  }

  current(ctx) { return this.ctx === ctx; }

  // ── VNH: extra roots ─────────────────────────────────────────────────────────────────
  // Each extra root is a copy of this panel (Object.create) with its own tree, git status, index
  // and folder watch; the shared UI state (cursor, scroll target) maps to keyOf(rid, rel).
  extraPaths() {
    const sp = activeSpace();
    if (!sp || sp.machine || this.on) return [];
    const seen = new Set([this.root]);
    return ((shared(FOLDERS) ?? {})[sp.id] ?? []).filter((p) => !seen.has(p) && seen.add(p)).slice(0, MAX_ROOTS - 1);
  }

  subList() { return this.isSub ? [] : (this.subs ?? []); }

  syncRoots(cx) {
    const want = this.extraPaths(), have = this.subs ?? [];
    if (want.length === have.length && want.every((p, i) => have[i].root === p)) return;
    const keep = new Map(have.map((s) => [s.root, s]));
    for (const s of have) if (!want.includes(s.root)) s.ctx = { gone: true };
    this.subs = want.map((p, i) => { const s = keep.get(p) ?? this.makeSub(p, cx); s.rid = i + 1; return s; });
  }

  makeSub(path, cx) {
    const view = this, sub = Object.create(view);
    sub.isSub = true; sub.view = view;
    sub.ctx = { key: JSON.stringify([path, null]), root: path, on: null }; sub.root = path; sub.on = null;
    sub.entries = new Map(); sub.folders = new Set(); sub.pending = new Set(); sub.git = emptyGit(); sub.index = null;
    sub.hits = null; sub.sizes = new Map(); sub.sizing = new Set(); sub.error = null; sub.limited = false;
    sub.loading = false; sub.again = false; sub.watched = null; sub.visible = []; sub.recent = [];
    const map = (name) => Object.defineProperty(sub, name, {
      get() { const k = parseKey(view[name]); return k && !k.head && k.rid === sub.rid ? k.rel : view[name] == null ? view[name] : "\u0000"; },
      set(v) { view[name] = v == null ? v : v === "" ? headKey(sub.rid) : keyOf(sub.rid, v); },
    });
    map("cursor"); map("scrollTo");
    sub.refresh(cx);
    return sub;
  }

  refreshAll(cx) { this.refresh(cx); for (const s of this.subList()) s.refresh(cx); }

  ownerOf(rid) { return rid === 0 ? this : this.subList().find((s) => s.rid === rid) ?? null; }

  rootOpen(R) { return !(this.closedRoots ?? new Set()).has(R.root); }
  toggleRoot(R, cx) {
    this.closedRoots ??= new Set();
    if (this.closedRoots.has(R.root)) this.closedRoots.delete(R.root); else this.closedRoots.add(R.root);
    cx.notify();
  }

  // Dropped from Finder: folders join the space (not ones already shown inside a root).
  dropFolders(paths, cx) {
    if (!paths?.length || this.isSub) return;
    cx.spawn(async () => {
      const r = await exec("sh", ["-c", 'for p in "$@"; do [ -d "$p" ] && printf "%s\\n" "$p"; done; true', "dirs", ...paths]).catch(() => null);
      const roots = [this.root, ...this.subList().map((s) => s.root)].filter(Boolean);
      const dirs = (r?.stdout ?? "").split("\n").map((d) => d.replace(/\/+$/, "")).filter(Boolean)
        .filter((d) => !roots.some((root) => d !== root && relTo(root, d) !== null));
      if (!dirs.length) { notify({ title: "Drop a folder to add it to the space", body: "Files and folders already shown here are left out.", level: "info", timeout: 3000 }); return; }
      await addSpaceFolders(dirs, this.root, this.git.top || this.root);
    });
  }

  // The panel's rows with several roots: a header per root, then its tree (one level in).
  multiRows(subs) {
    const out = [], searching = Boolean(this.query.trim());
    for (const R of [this, ...subs]) {
      const rid = R === this ? 0 : R.rid, key = headKey(rid), open = searching || this.rootOpen(R);
      out.push({ rel: key, key, head: true, rid, owner: R, e: { name: baseOf(R.root) || R.root, dir: true }, depth: 0, open });
      if (!open || (searching && R.hits === null)) continue;
      for (const r of R.treeRows(1)) out.push(R === this ? r : { ...r, rel: keyOf(rid, r.rel), key: keyOf(rid, r.rel), local: r.rel, owner: R, rid });
    }
    return out;
  }

  searchSub(S, q, seq, cx) {
    const ctx = S.ctx;
    cx.spawn(async (cx) => {
      try {
        if (!S.index) { const index = await buildIndex(S.root, S.on); if (S.ctx !== ctx) return; S.index = index; }
        if (seq !== this.searchSeq) return;
        const matches = S.index.all.filter((rel) => rel.toLowerCase().includes(q) && (this.showHidden || !rel.split("/").some((x) => x.startsWith("."))) && (this.showIgnored || !S.isIgnored(rel)));
        const named = matches.filter((rel) => baseOf(rel).toLowerCase().includes(q));
        S.hits = [...new Set([...named, ...matches])].slice(0, FIND_LIMIT);
      } catch { if (seq === this.searchSeq) S.hits = []; }
      finally { cx.notify(); }
    });
  }

  // A root's header: chevron, folder, name in its git color, branch and counts.
  rootRow(r, t, R) {
    const o = r.owner, g = o.git, b = g.branch, tone = tones(t), selected = r.key === this.cursor;
    const c = g.counts.get("") ?? [0, 0, 0], changes = c[0] + c[1] + c[2], gc = changes ? gitColor(t, g.status.get("")) : null;
    // Drag a root into a terminal or Claude Code's input: `@<absolute folder>` (a root outside the
    // agent's folder, so never relative); another machine's root gives its plain path.
    return h_flex().drag_paths([o.on ? o.root : `@${o.root}`], { on: o.on ?? null })
      .id(`ft-${r.key}`).h(ROW).flex_none().pl(6).pr(10).gap(6).items_center().rounded(R).cursor_pointer()
      .when(selected, (el) => el.bg(t.selected)).when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
      .child(svg(ICON(`chevron-${r.open ? "down" : "right"}`)).size(12).flex_none().text_color(t.dim))
      .child(image(fileIcon(o.root, true, r.open, settings().dark !== false)).size(16).flex_none())
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(gc ?? t.foreground).child(r.e.name))
      .when(Boolean(b?.head) && this.width > 230, (el) => el.child(h_flex().flex_none().gap(3).items_center().text_size(11).text_color(t.dim)
        .child(svg(ICON("git-branch")).size(10).flex_none()).child(div().max_w(96).truncate().child(b.head))))
      .when(Boolean(b?.ahead), (el) => el.child(div().flex_none().text_size(11).text_color(tone.teal).child(`↑${b.ahead}`)))
      .when(Boolean(b?.behind), (el) => el.child(div().flex_none().text_size(11).text_color(tone.blue).child(`↓${b.behind}`)))
      .when(changes > 0, (el) => el.child(div().flex_none().size(6).rounded(3).bg(gc ?? t.ansi3)));
  }

  // Presses, keys and menus on an extra root's rows (and on root headers).
  pressMulti(k, key, cx) {
    const R = this.ownerOf(k.rid);
    if (!R) return;
    this.handle.focus();
    this.cursor = key;
    if (k.head) { this.toggleRoot(R, cx); return; }
    const r = this.rows().find((x) => x.rel === key);
    if (!r) return;
    const x = this.downX; this.downX = null;
    const abs = join(R.root, k.rel);
    if (x !== null && x !== undefined && !r.e?.dir && this.onEye(r, x)) { openInHelix(abs, R.on ?? null, R.root); cx.notify(); return; }
    const now = Date.now(), double = this.lastPress?.rel === key && now - this.lastPress.at < 450;
    this.lastPress = double ? null : { rel: key, at: now };
    if (r.e.dir) { if (r.flat || R.hits) { this.clearSearch(cx); this.setView("tree", cx); R.open([...ancestors(k.rel), k.rel], cx, () => { this.scrollTo = key; }); } else R.toggle(k.rel, cx); }
    else if (double) this.showAbs(abs, `${baseOf(R.root)}/${k.rel}`, cx);
    cx.notify();
  }

  keyMulti(k, cur, e, cx) {
    const kk = e.key, R = this.ownerOf(k.rid);
    if (!R) return false;
    if (k.head) {
      const open = this.rootOpen(R);
      if (((kk === "right" || kk === "l") && !open) || ((kk === "left" || kk === "h") && open) || kk === "enter" || kk === "space") this.toggleRoot(R, cx);
      else if (kk === "y") copy(cx, R.root);
      else return false;
      return true;
    }
    const abs = join(R.root, k.rel), shift = e.modifiers?.shift;
    if ((kk === "right" || kk === "l") && cur.e.dir && !cur.open) R.toggle(k.rel, cx);
    else if (kk === "left" || kk === "h") { if (cur.e.dir && cur.open) R.toggle(k.rel, cx); else this.cursor = dirOf(k.rel) ? keyOf(k.rid, dirOf(k.rel)) : headKey(k.rid); this.scrollTo = this.cursor; }
    else if (kk === "enter") { if (cur.e.dir) R.toggle(k.rel, cx); else this.showAbs(abs, `${baseOf(R.root)}/${k.rel}`, cx); }
    else if (kk === "space") { if (cur.e.dir) R.toggle(k.rel, cx); else openInHelix(abs, R.on ?? null, R.root); }
    else if (kk === "p" && !cur.e.dir) this.showAbs(abs, `${baseOf(R.root)}/${k.rel}`, cx);
    else if (kk === "y") copy(cx, shift ? abs : k.rel);
    else if (kk === "a") sendToAgent(cx, abs);
    else return false;
    return true;
  }

  // A file of another root in the preview: `abs` is read, `label` titles it.
  showAbs(abs, label, cx) {
    this.show(label, cx, false, abs);
  }

  sync(cx) {
    const { root, on } = this.wanted();
    if (root === this.root && on === this.on) return;
    this.reset(root, on);
    this.refresh(cx);
  }

  refresh(cx) {
    if (!this.root) return;
    if (this.loading) { this.again = true; return; }
    const ctx = this.ctx;
    this.loading = true; this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(ctx)) return;
          try { await this.loadFolder(path, ctx); }
          catch (e) { if (!path) throw e; this.folders.delete(path); this.entries.delete(path); }
        }
        await this.readGit(ctx);
        if (!this.current(ctx)) return;
        this.error = null;
        this.watch(cx);
      } catch (e) { if (this.current(ctx)) this.error = String(e?.message ?? e); }
      finally {
        if (this.current(ctx)) {
          this.loading = false;
          if (this.again) { this.again = false; this.refresh(cx); }
        }
        cx.notify();
      }
    });
  }

  async loadFolder(path, ctx) {
    const { entries, more } = await listDir(join(ctx.root, path), ctx.on);
    if (!this.current(ctx) || (path && !this.folders.has(path))) return;
    this.entries.set(path, entries);
    if (more) this.limited = true;
  }

  async readGit(ctx) {
    const g = (args) => exec("git", [...READ, ...args], { cwd: ctx.root, on: ctx.on });
    const git = emptyGit();
    const top = await g(["rev-parse", "--show-toplevel", "--show-prefix"]).catch(() => null);
    if (top?.code === 0) {
      const [dir, prefix = ""] = top.stdout.split("\n");
      git.top = dir.trim(); git.prefix = prefix.trim();
      const status = await g(["status", "--porcelain=v1", "-z", "-b", "--no-renames", "--untracked-files=normal", "--ignored=traditional", "--", "."]);
      if (status.code === 0) parseStatus(status.stdout, git);
      const head = await g(["rev-parse", "--verify", "-q", "HEAD"]);
      if (head.code === 0) {
        const numstat = await g(["diff", "HEAD", "--numstat", "-z", "--no-renames", "--", "."]);
        if (numstat.code === 0) parseNumstat(numstat.stdout, git);
      }
    }
    if (this.current(ctx)) this.git = git;
  }

  watch(cx) {
    if (this.on || this.watched === this.root) return;
    const ctx = this.ctx, root = this.root;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.current(ctx)) {
          const paths = await watchFolder(root);
          if (!this.current(ctx)) return;
          this.changed(paths, cx);
        }
      } catch { if (this.current(ctx)) this.watched = null; }
    });
  }

  changed(paths, cx) {
    const now = Date.now();
    this.recent = this.recent.filter((r) => now - r.at < 15000);
    this.recent.push({ at: now, paths });
    let structural = false, gitState = false;
    for (const abs of paths) {
      const rel = relTo(this.root, abs);
      if (rel === null) continue;
      if (rel === ".git" || rel.startsWith(".git/")) {
        // VNH: only what moves git status (index, HEAD, refs, a merge or rebase). fsmonitor's
        // cookies, objects and logs change on every git call anyone makes, and refreshing on
        // them ran this panel's git status at other tools' pace.
        if (/^\.git\/(index|HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|packed-refs|refs\/|rebase-|sequencer)/.test(rel)) gitState = true;
        continue;
      }
      structural = true;
      for (const d of [...ancestors(rel), ""]) this.sizes.delete(d);
    }
    if (structural && !this.query) this.index = null;
    if (structural || gitState) this.refresh(cx);
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) { this.folders.delete(folder); this.entries.delete(folder); }
    } else this.open([path], cx);
    cx.notify();
  }

  // Opens folders (and their parents) and loads what they hold.
  open(paths, cx, then) {
    const ctx = this.ctx, todo = [];
    for (const p of paths) for (const d of [...ancestors(p).reverse(), p]) if (d && !this.folders.has(d)) { this.folders.add(d); todo.push(d); }
    cx.spawn(async (cx) => {
      for (const d of todo) {
        if (!this.current(ctx)) return;
        if (this.entries.has(d) || this.pending.has(d)) continue;
        this.pending.add(d);
        try { await this.loadFolder(d, ctx); }
        catch { this.folders.delete(d); }
        finally { this.pending.delete(d); }
      }
      if (this.current(ctx)) then?.();
      cx.notify();
    });
  }

  // VNH: everything closes: the open folders of every root (the space's own and the folders added to it) and, when there are
  // several roots, their headers too, so only the headers are left; a click on a header opens it again.
  collapseAll(cx) {
    const roots = [this, ...this.subList()];
    for (const R of roots) { R.folders = new Set(); for (const k of [...R.entries.keys()]) if (k) R.entries.delete(k); }
    if (roots.length > 1) this.closedRoots = new Set(roots.map((R) => R.root));
    cx.notify();
  }

  // ── search ───────────────────────────────────────────────────────────────────────────
  search(query, cx) {
    this.query = query;
    const q = query.trim().toLowerCase();
    // Recent filters its own short list in rows(); only the tree searches disk.
    for (const S of this.subList()) S.hits = null;
    if (!q || this.view !== "tree") { this.hits = null; cx.notify(); return; }
    const seq = ++this.searchSeq, ctx = this.ctx;
    for (const S of this.subList()) this.searchSub(S, q, seq, cx);
    this.searching = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.index) {
          const index = await buildIndex(ctx.root, ctx.on);
          if (!this.current(ctx)) return;
          this.index = index;
        }
        if (seq !== this.searchSeq) return;
        const matches = this.index.all.filter((rel) => rel.toLowerCase().includes(q) && (this.showHidden || !rel.split("/").some((s) => s.startsWith("."))) && (this.showIgnored || !this.isIgnored(rel)));
        const named = matches.filter((rel) => baseOf(rel).toLowerCase().includes(q));
        this.hits = [...new Set([...named, ...matches])].slice(0, FIND_LIMIT);
        this.cursor = this.hits[0] ?? "";
        this.scrollTo = this.cursor;
      } catch (e) { if (seq === this.searchSeq) this.hits = []; this.error = String(e?.message ?? e); }
      finally { if (seq === this.searchSeq) this.searching = false; cx.notify(); }
    });
  }

  clearSearch(cx) {
    this.query = ""; this.hits = null; this.searchSeq++;
    for (const S of this.subList()) S.hits = null;
    this.input.set_value("");
    cx.notify();
  }

  jump(cx) {
    if (this.view !== "tree") {
      const first = this.rows().find((r) => r.rel === this.cursor) ?? this.rows()[0];
      if (first) { this.cursor = first.rel; this.handle.focus(); this.openFile(first.rel, cx); }
      return;
    }
    const mk = parseKey(this.cursor);
    if (mk && !mk.head) { const R = this.ownerOf(mk.rid), key = this.cursor; this.clearSearch(cx); this.cursor = key; this.handle.focus(); R?.open(ancestors(mk.rel), cx, () => { this.scrollTo = key; }); return; }
    const target = this.hits?.includes(this.cursor) ? this.cursor : this.hits?.[0];
    this.clearSearch(cx);
    if (!target) return;
    this.cursor = target;
    this.handle.focus();
    this.open(ancestors(target), cx, () => { this.scrollTo = target; });
  }

  // ── rows ─────────────────────────────────────────────────────────────────────────────
  rows() {
    const q = this.query.trim().toLowerCase();
    if (this.view === "recent") return this.recentRows(q);
    const subs = this.subList();
    return subs.length ? this.multiRows(subs) : this.treeRows(0);
  }

  // One root's tree (or its search hits), `base` levels in.
  treeRows(base) {
    const out = [];
    if (this.hits) {
      const keep = new Set(), kids = new Map(), dirs = this.index?.dirs ?? new Set();
      for (const h of this.hits) { keep.add(h); for (const a of ancestors(h)) keep.add(a); }
      for (const rel of keep) { const p = dirOf(rel); if (!kids.has(p)) kids.set(p, []); kids.get(p).push(rel); }
      const entryOf = (rel) => this.entries.get(dirOf(rel))?.find((e) => e.name === baseOf(rel)) ?? { name: baseOf(rel), dir: dirs.has(rel), size: null, mtime: 0 };
      const walk = (p, depth) => {
        const list = (kids.get(p) ?? []).sort((a, b) => Number(dirs.has(b)) - Number(dirs.has(a)) || collator.compare(baseOf(a), baseOf(b)));
        for (const rel of list) { const e = entryOf(rel); out.push({ rel, e, depth, open: kids.has(rel) }); if (kids.has(rel)) walk(rel, depth + 1); }
      };
      walk("", base);
      return out;
    }
    const walk = (prefix, depth) => {
      for (const e of this.entries.get(prefix) ?? []) {
        if (!this.showHidden && e.name.startsWith(".")) continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name, open = e.dir && this.folders.has(rel);
        if (!this.showIgnored && this.isIgnored(rel)) continue;
        out.push({ rel, e, depth, open });
        if (open && depth < 40) walk(rel, depth + 1);
      }
    };
    walk("", base);
    return out;
  }

  // Recent: what Claude read, wrote or committed here, newest first, one row per file.
  recentRows(q) {
    const seen = new Set(), out = [], subs = this.subList();
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      if (!this.allAgents && h.session && !this.isMine(h.session)) continue; // another agent's
      let owner = this, rel = relTo(this.root, h.abs);
      if (!rel) for (const S of subs) { const x = relTo(S.root, h.abs); if (x) { owner = S; rel = x; break; } }
      const key = owner === this ? rel : rel && keyOf(owner.rid, rel);
      if (!rel || seen.has(key) || (q && !rel.toLowerCase().includes(q))) continue;
      seen.add(key);
      const e = owner.entries.get(dirOf(rel))?.find((x) => x.name === baseOf(rel)) ?? { name: baseOf(rel), dir: false, size: null, mtime: 0 };
      out.push(owner === this ? { rel, e, depth: 0, flat: true, recent: h } : { rel: key, key, local: rel, owner, rid: owner.rid, e, depth: 0, flat: true, recent: h });
    }
    return out;
  }

  isIgnored(rel) {
    if (!this.git.ignored.size) return false;
    for (let r = rel; r; r = dirOf(r)) if (this.git.ignored.has(r)) return true;
    return false;
  }
  underUntracked(rel) {
    if (!this.git.untracked.size) return false;
    for (let r = rel; r; r = dirOf(r)) if (this.git.untracked.has(r)) return true;
    return false;
  }

  // ── Claude activity, from the hook bridge ────────────────────────────────────────────
  watchActivity(cx) {
    const dir = `${home()}/.local/state/herdr-filetree`;
    cx.spawn(async (cx) => {
      try { await exec("mkdir", ["-p", dir]); } catch {}
      try {
        for (;;) {
          await watchFolder(dir);
          await this.readActivity(`${dir}/activity.jsonl`, cx);
        }
      } catch {}
    });
  }

  async readActivity(file, cx) {
    const text = await readTextFile(file).catch(() => null);
    if (!text) return;
    const fresh = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { const e = JSON.parse(line); if (e.at > this.seenAt) fresh.push(e); } catch {}
    }
    if (!fresh.length) return;
    this.seenAt = Math.max(...fresh.map((e) => e.at));
    const mode = this.config.activity, reads = mode === "reads and writes" || mode === "reads", writes = mode === "reads and writes" || mode === "writes";
    for (const e of fresh) {
      if (e.kind === "read" && reads) this.flash(e.paths ?? [], "purple", cx, e.paths?.length > 1 ? SEARCH_REVEAL : READ_REVEAL, e.session);
      else if (e.kind === "write" && writes) this.flash(e.paths ?? [], "orange", cx, READ_REVEAL, e.session);
      else if (e.kind === "mention") { if (this.isMine(e.session)) this.reveal(e.paths ?? [], cx); }
      else if (e.kind === "bash-start") this.bashStarts.set(e.id, e.at);
      else if (e.kind === "bash-end" && writes) {
        const start = this.bashStarts.get(e.id) ?? e.at - 5000;
        this.bashStarts.delete(e.id);
        // The folder watch reports Bash's writes a moment later; take what changed while it ran.
        cx.timer.after(1200, (cx) => {
          const paths = new Set();
          for (const r of this.recent) if (r.at >= start - 300 && r.at <= e.at + 1200) for (const p of r.paths) {
            const rel = relTo(this.root, p);
            if (rel && rel !== ".git" && !rel.startsWith(".git/") && !this.isIgnored(rel)) paths.add(p);
          }
          this.flash([...paths].slice(0, 60), "orange", cx, READ_REVEAL, e.session);
        });
      } else if (e.kind === "git") this.gitEvent(e, cx);
    }
    cx.notify();
  }

  related(cwd) {
    const base = this.git.top || this.root;
    return Boolean(base && cwd && (relTo(base, cwd) !== null || relTo(cwd, base) !== null));
  }

  gitEvent(e, cx) {
    if (!this.related(e.cwd)) return;
    const a = e.actions?.[e.actions.length - 1];
    if (!a) return;
    this.chip = { label: e.actions.map((x) => x.label).join(" · "), tone: a.tone, state: e.state, detail: e.detail ?? "", at: e.at };
    if (e.state !== "running") {
      this.branchFlash = { tone: a.tone, at: Date.now() };
      if (e.paths?.length) this.flash(e.paths, "green", cx, READ_REVEAL);
      this.refresh(cx);
    }
  }

  flash(paths, tone, cx, limit, session) {
    const now = Date.now(), inside = [];
    // The tree follows (opens folders, scrolls) only for the agent in view; the others still light their files.
    const follow = this.config.follow && this.isMine(session);
    for (const abs of paths) {
      const path = abs.replace(/\\/g, "/");
      this.flashes.set(path, { tone, at: now });
      this.history.push({ abs: path, kind: KIND[tone] ?? "write", at: now, session: session ?? null });
      if (session && tone === "orange") {
        if (!this.sessionFiles.has(session)) this.sessionFiles.set(session, new Set());
        this.sessionFiles.get(session).add(path);
        this.filesDirty = true;
      }
      const rel = relTo(this.root, abs);
      if (rel) inside.push(rel);
    }
    if (this.history.length > 120) this.history = this.history.slice(-80);
    try { localStorage.setItem("history", JSON.stringify(this.history)); } catch {}
    // VNH: what Claude touched in another root opens there too.
    if (follow && !this.query && this.view === "tree") for (const S of this.subList()) {
      const rels = paths.map((p) => relTo(S.root, p)).filter(Boolean).slice(0, limit);
      if (rels.length) { const last = rels[rels.length - 1]; S.open(rels.flatMap((rel) => ancestors(rel)), cx, () => { if (!inside.length) this.scrollTo = keyOf(S.rid, last); }); }
    }
    if (!inside.length || !follow || this.hits || this.view !== "tree") { cx.notify(); return; }
    const shown = inside.slice(0, limit), last = shown[shown.length - 1];
    this.open(shown.flatMap((rel) => ancestors(rel)), cx, () => { this.scrollTo = last; });
  }

  reveal(paths, cx) {
    const rels = paths.map((p) => relTo(this.root, p)).filter(Boolean);
    if (!rels.length) return;
    const last = rels[rels.length - 1];
    this.cursor = last;
    this.open(rels.flatMap((rel) => ancestors(rel)), cx, () => { this.scrollTo = last; });
  }

  flashOf(rel, open, now) {
    const abs = join(this.root, rel).replace(/\\/g, "/");
    const f = this.flashes.get(abs);
    if (f && now - f.at < TINT_MS) return { tone: f.tone, bright: now - f.at < FLASH_MS };
    // A folder that is closed over something lit glows faintly.
    if (!open && this.flashes.size) {
      const prefix = abs + "/";
      let best = null;
      for (const [p, v] of this.flashes) if (now - v.at < FLASH_MS && p.startsWith(prefix) && (!best || v.at > best.at)) best = v;
      if (best) return { tone: best.tone, bright: false };
    }
    return null;
  }

  // Redraws only when a highlight changes state (bright → tinted → gone), not every second.
  // The Claude session(s) of the agent in the focused pane (or, with a shell focused, of the agents of its tab), read from the
  // status files the status line writes. null: unknown, so nothing is filtered.
  async readMine() {
    const f = focused();
    if (!f?.tab) return;
    const fp = f.pane ? panes().find((p) => p.pane === f.pane) : null;
    const terms = fp?.status && fp.terminal ? [fp.terminal] : agents().filter((a) => a.tab === f.tab).map((a) => a.address);
    const key = terms.join(",");
    const now = Date.now();
    if (key === this.mineKey && now - this.mineAt < 5000) return;
    this.mineKey = key; this.mineAt = now;
    const sessions = new Set();
    this.lastSession ??= new Map(); // a half-written or session-less read keeps the session last seen (no flicker)
    for (const t of terms) {
      const text = await readTextFile(`${home()}/.cache/herdr-status/${t}.json`).catch(() => null);
      try { const id = JSON.parse(text ?? "{}").session; if (id) this.lastSession.set(t, id); } catch {}
      if (this.lastSession.has(t)) sessions.add(this.lastSession.get(t));
    }
    const next = sessions.size ? sessions : terms.length ? new Set() : null; // an agent without a session yet has nothing
    if ((next?.size ?? 0) !== (this.mine?.size ?? 0) || [...(next ?? [])].some((x) => !this.mine?.has(x))) { this.mine = next; this.agoAt = 0; this.dirtyMine = true; }
  }
  // Does an event of `session` belong to the agent in view? Unknown on either side: yes.
  isMine(session) { return !session || !this.mine || this.mine.has(session); }

  tick(cx) {
    const now = Date.now();
    let dirty = false;
    this.readMine().then(() => { if (this.dirtyMine) { this.dirtyMine = false; cx.notify(); } }).catch(() => {});
    for (const [p, v] of this.flashes) {
      const age = now - v.at;
      if (age >= TINT_MS) { this.flashes.delete(p); dirty = true; }
      else if (age >= FLASH_MS && age < FLASH_MS + 1000) dirty = true;
    }
    if (this.chip && now - this.chip.at > (this.chip.state === "running" ? RUNNING_MS : CHIP_MS)) { this.chip = null; dirty = true; }
    if (this.branchFlash && now - this.branchFlash.at > FLASH_MS) { this.branchFlash = null; dirty = true; }
    if (this.showSize && this.view === "tree") { this.pumpSizes(cx); for (const S of this.subList()) S.pumpSizes(cx); }
    // Recent shows "4m ago"-style times; refresh them twice a minute, only while shown.
    if (this.view === "recent" && now - this.agoAt > 30000) { this.agoAt = now; dirty = true; }
    if (dirty) cx.notify();
  }

  // ── sizes ────────────────────────────────────────────────────────────────────────────
  pumpSizes(cx) {
    if (windows(this.on)) return;
    const ctx = this.ctx;
    for (const rel of this.visible) {
      if (this.sizing.size >= 2) break;
      if (this.sizes.has(rel) || this.sizing.has(rel)) continue;
      this.sizing.add(rel);
      cx.spawn(async (cx) => {
        try {
          const r = await exec("du", ["-sk", "--", join(ctx.root, rel)], { on: ctx.on });
          const kb = Number(r.stdout.split(/\s/)[0]);
          if (this.current(ctx)) this.sizes.set(rel, Number.isFinite(kb) ? kb * 1024 : -1);
        } catch { if (this.current(ctx)) this.sizes.set(rel, -1); }
        finally { this.sizing.delete(rel); cx.notify(); }
      });
    }
  }

  // ── preview and opening ──────────────────────────────────────────────────────────────
  closePreview() {
    this.code?.release();
    this.code = null; this.md = null; this.file = null; this.fileError = null; this.fileAbs = null;
  }

  // inRender: called while drawing (a request from another mod), where notify is refused.
  show(rel, cx, inRender = false, abs = null) {
    this.closePreview();
    this.file = rel; this.fileAbs = abs;
    const ctx = this.ctx;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(abs ?? join(ctx.root, rel), { on: abs ? null : ctx.on });
        if (this.file !== rel || !this.current(ctx)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const value = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        const ext = rel.includes(".") ? rel.split(".").pop().toLowerCase() : "txt";
        if (ext === "md" || ext === "markdown" || ext === "mdx") { this.md = value; return; }
        const t = theme();
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true, value,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === rel && this.current(ctx)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
    if (!inRender) cx.notify();
  }

  // Double-click and Enter: config.json's "open". "preview" shows it here; "" the default
  // app; anything else is a command with {path} and {dir}, run without a shell.
  openFile(rel, cx) {
    const how = String(this.config.open ?? "preview").trim(), abs = join(this.root, rel);
    if (how === "preview" || this.on) { this.show(rel, cx); return; }
    cx.spawn(async (cx) => {
      try {
        if (!how) await openExternal(abs);
        else {
          const argv = words(how), dir = abs.replace(/[\\/][^\\/]*$/, "");
          const filled = argv.map((w) => w.replace(/\{(path|dir)\}/g, (_, k) => (k === "path" ? abs : dir)));
          const r = await exec(filled[0], [...filled.slice(1), ...(argv.some((w) => w.includes("{path}")) ? [] : [abs])], { cwd: dir });
          if (r.code !== 0) throw new Error(r.stderr.trim() || `${filled[0]} exited ${r.code}`);
        }
      } catch (e) { notify({ title: "Could not open the file", body: String(e?.message ?? e), level: "error", timeout: 4000 }); this.show(rel, cx); }
      cx.notify();
    });
  }

  openMenu(rel, dir) {
    const abs = join(this.root, rel);
    openOverlay({ mod: NAME, kind: "popup", width: 210, height: dir ? 5 * 28 + 10 : 7 * 28 + 10, props: { menu: { root: this.root, rel, abs, dir, local: !this.on } } });
  }

  // VNH: a root's menu; the space's own folder can't be removed.
  openRootMenu(R) {
    const sp = activeSpace(), main = R === this;
    openOverlay({ mod: NAME, kind: "popup", width: 230, height: (main ? 3 : 5) * 28 + 10 + (main ? 0 : 9),
      props: { menu: { rootMenu: true, main, root: R.root, abs: R.root, rel: "", dir: true, local: true, space: sp?.id ?? null, project: this.git.top || this.root } } });
  }

  // A virtual list's rows can't hold handlers, so the list reports the row and
  // a second press on the same row within 450 ms is the double-click.
  // VNH: whether a press at x (in the list's box) fell on the eye after a Markdown row's name. The
  // list gives no per-row geometry, so the eye's place is worked out as the row lays it out: list
  // padding 4, row padding 6 + 14 a level (none for a flat row), chevron slot 12, gap 6, icon 16, gap 6,
  // the name (the UI font is monospaced: charWidth() a character at 13 px), gap 6, then the 16 px eye.
  onEye(r, x) {
    if (r.flat) return false; // Recent rows draw no eye
    // Press positions are window pixels; layout sizes are scaled by the app's zoom.
    const zoom = Number(settings().zoom) > 0 ? Number(settings().zoom) : 1;
    x = x / zoom;
    const indent = r.flat ? 8 : 6 + (r.depth ?? 0) * 14;
    const name = (r.e?.name ?? baseOf(r.rel)) + (r.e?.link ? " ↪" : "");
    const start = 4 + indent + (r.flat ? 0 : 12 + 6) + 16 + 6 + [...name].length * charWidth() + 6;
    // From the end of the name rightwards (the eye and the blank after it); the name itself selects.
    // A name too long for the row is cut short and its eye sits earlier: the row's last 120 px
    // (the eye and the date beside it) count too.
    const width = typeof this.downW === "number" ? this.downW / zoom : null;
    return x >= start - 6 || (width !== null && x >= width - 120);
  }

  press(rel, cx) {
    const mk = parseKey(rel);
    if (mk) { this.pressMulti(mk, rel, cx); return; }
    const r = this.rows().find((x) => x.rel === rel);
    if (!r) return;
    const x = this.downX; this.downX = null;
    if (x !== null && x !== undefined && !r.e?.dir && this.onEye(r, x)) { this.cursor = rel; openInHelix(join(this.root, rel), this.on, this.root); cx.notify(); return; }
    const now = Date.now(), double = this.lastPress?.rel === rel && now - this.lastPress.at < 450;
    this.lastPress = double ? null : { rel, at: now };
    this.handle.focus();
    this.cursor = rel;
    if (r.flat && r.e.dir) this.revealInTree(rel, cx);
    else if (r.e.dir) { if (this.hits) this.jump(cx); else if (!double) this.toggle(rel, cx); }
    else if (double) this.openFile(rel, cx);
    cx.notify();
  }

  // ── keyboard ─────────────────────────────────────────────────────────────────────────
  move(rows, delta) {
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.rel === this.cursor);
    const next = Math.max(0, Math.min(rows.length - 1, at < 0 ? (delta > 0 ? 0 : rows.length - 1) : at + delta));
    this.cursor = rows[next].rel;
    this.scroll.scroll_to_item(next);
  }

  revealInTree(rel, cx) {
    this.setView("tree", cx);
    if (this.query) this.clearSearch(cx);
    this.cursor = rel;
    this.open(ancestors(rel), cx, () => { this.scrollTo = rel; });
  }

  key(e, cx) {
    const k = e.key, rows = this.rows(), cur = rows.find((r) => r.rel === this.cursor);
    if (this.typing) {
      if (k === "escape") { if (this.query) this.clearSearch(cx); else this.handle.focus(); }
      else if (k === "down" || k === "up") this.move(rows, k === "down" ? 1 : -1);
      else return;
      cx.stop_propagation(); cx.notify(); return;
    }
    if (this.file) {
      if (k === "escape" || k === "left" || k === "h") this.closePreview();
      else if (k === "o" && !this.on) openExternal(this.fileAbs ?? join(this.root, this.file)).catch(() => {});
      else if (k === "space") openInHelix(this.fileAbs ?? join(this.root, this.file), this.on, this.root);
      else return;
      cx.stop_propagation(); cx.notify(); return;
    }
    const shift = e.modifiers?.shift;
    const mk = parseKey(this.cursor);
    if (mk && cur && !["up", "k", "down", "j", "pageup", "pagedown", "home", "end", "/", ".", "i", "escape"].includes(k) && !/^[1-9]$/.test(k)) {
      if (this.keyMulti(mk, cur, e, cx)) { cx.stop_propagation(); cx.notify(); }
      return;
    }
    if (k === "up" || k === "k") this.move(rows, -1);
    else if (k === "down" || k === "j") this.move(rows, 1);
    else if (k === "pageup") this.move(rows, -10);
    else if (k === "pagedown") this.move(rows, 10);
    else if (k === "home") this.move(rows, -rows.length);
    else if (k === "end") this.move(rows, rows.length);
    else if (k === "/") { this.input.focus(); }
    else if (k === ".") { this.showHidden = !this.showHidden; this.savePrefs(); }
    else if (k === "i") { this.showIgnored = !this.showIgnored; this.savePrefs(); }
    else if (k === "escape") { if (this.query) this.clearSearch(cx); else this.cursor = ""; }
    else if (/^[1-9]$/.test(k) && VIEWS[Number(k) - 1]) this.setView(VIEWS[Number(k) - 1][0], cx);
    else if (!cur) return;
    else if (cur.flat && (k === "right" || k === "l")) this.revealInTree(cur.rel, cx);
    else if (cur.flat && (k === "left" || k === "h")) return;
    else if (cur.flat && cur.e.dir && (k === "enter" || k === "space")) this.revealInTree(cur.rel, cx);
    else if ((k === "right" || k === "l") && cur.e.dir && !cur.open) this.toggle(cur.rel, cx);
    else if (k === "left" || k === "h") { if (cur.e.dir && cur.open && !this.hits) this.toggle(cur.rel, cx); else if (dirOf(cur.rel) || cur.depth) { this.cursor = dirOf(cur.rel); this.scrollTo = this.cursor; } }
    else if (k === "enter") { if (this.hits) this.jump(cx); else if (cur.e.dir) this.toggle(cur.rel, cx); else this.openFile(cur.rel, cx); }
    else if (k === "space") { if (cur.e.dir) this.toggle(cur.rel, cx); else openInHelix(join(this.root, cur.rel), this.on, this.root); }
    else if (k === "p" && !cur.e.dir) this.show(cur.rel, cx);
    else if (k === "y") copy(cx, shift ? join(this.root, cur.rel) : cur.rel);
    else if (k === "a") sendToAgent(cx, join(this.root, cur.rel));
    else return;
    cx.stop_propagation(); cx.notify();
  }

  // ── drawing ──────────────────────────────────────────────────────────────────────────
  button(id, label, tip, on, onClick, t, R) {
    return div().id(id).h(20).min_w(20).px(4).flex_none().flex().items_center().justify_center().rounded(R).cursor_pointer()
      .text_size(12).text_color(on ? t.foreground : t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .child(label);
  }

  pill(letter, color, R) {
    return div().size(16).flex_none().flex().items_center().justify_center().rounded(Math.min(R, 3)).bg(alpha(color, 0.15)).text_color(color).text_size(10).font_semibold().child(letter);
  }

  // A row of Recent: a status pill, the name, then what happened to it.
  // VNH (as vnh-files): drag a row into a terminal or an agent's input. Here it types `@<path>`
  // relative to this panel's folder (Claude Code reads it as a file or folder mention); on another
  // machine the absolute path. No trailing "/" on a folder: such a path dropped nothing.
  dragged(el, rel, _dir) {
    const path = this.on ? join(this.root, rel) : this.isSub ? `@${join(this.root, rel)}` : `@${rel}`;
    return el.drag_paths([path], { on: this.on ?? null });
  }

  flatRow(r, t, R, now, key) {
    const { rel, e } = r, tone = tones(t), selected = rel === this.cursor;
    const fl = this.flashOf(rel, true, now), lit = fl ? tone[fl.tone] : null;
    const pulse = (el) => el.loop("opacity", { from: 0.35, to: 1, period: 900 });
    const h = r.recent, color = h.kind === "read" ? tone.purple : h.kind === "commit" ? tone.green : tone.orange;
    return this.dragged(h_flex(), rel, Boolean(e?.dir)).id(`ft-${key ?? rel}`).h(ROW).flex_none().pl(8).pr(10).gap(7).items_center().rounded(R).cursor_pointer()
      .when(selected, (el) => el.bg(t.selected)).when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
      .when(Boolean(fl?.bright), (el) => el.bg(alpha(lit, 0.13)))
      .child(this.pill(h.kind === "read" ? "R" : h.kind === "commit" ? "C" : "W", color, R))
      .child(div().flex_none().max_w(Math.max(80, this.width * 0.5)).truncate().text_color(lit ?? t.foreground).when(Boolean(fl?.bright), pulse).child(e.name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dirOf(rel)))
      .child(div().flex_none().text_size(11).text_color(color).child(h.kind === "read" ? "read" : h.kind === "commit" ? "committed" : "wrote"))
      .child(div().flex_none().w(26).text_size(11).text_color(t.dim).text_right().child(ago(h.at)));
  }

  row(r, t, R, now, key) {
    if (r.head) return this.rootRow(r, t, R);
    if (r.owner && r.owner !== this) return r.flat ? r.owner.flatRow({ ...r, rel: r.local }, t, R, now, r.key) : r.owner.row({ ...r, rel: r.local, owner: null }, t, R, now, r.key);
    if (r.flat) return this.flatRow(r, t, R, now, key);
    const { rel, e, depth, open } = r, g = this.git, tone = tones(t);
    const status = g.status.get(rel) ?? (this.underUntracked(rel) ? "?" : null);
    const ignored = !status && this.isIgnored(rel);
    const fl = this.flashOf(rel, open, now), lit = fl ? tone[fl.tone] : null;
    const gc = gitColor(t, status), hidden = e.name.startsWith(".");
    const nameColor = lit ?? (ignored ? t.dim : gc ?? (hidden ? t.muted : t.foreground));
    const loc = !e.dir ? g.diff.get(rel) : null, counts = e.dir ? g.counts.get(rel) : null;
    const meta = this.showSize
      ? (e.dir ? (this.sizes.has(rel) ? formatSize(this.sizes.get(rel)) : "…") : formatSize(e.size))
      : (!e.dir && !loc && this.width > 250 ? stamp(e.mtime) : "");
    const selected = rel === this.cursor;
    const pulse = (el) => el.loop("opacity", { from: 0.35, to: 1, period: 900 });
    return this.dragged(h_flex(), rel, e.dir).id(`ft-${key ?? rel}`).h(ROW).flex_none().pl(6 + depth * 14).pr(10).gap(6).items_center().rounded(R).cursor_pointer()
      .when(selected, (el) => el.bg(t.selected)).when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
      .when(Boolean(fl?.bright), (el) => el.bg(alpha(lit, 0.13)))
      .child(e.dir ? svg(ICON(`chevron-${open ? "down" : "right"}`)).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(image(fileIcon(rel, e.dir, open, settings().dark !== false)).size(16).flex_none().when(Boolean(fl?.bright), pulse))
      .child(div().flex_1().min_w(0).truncate().text_color(nameColor).when(selected, (el) => el.font_medium())
        .when(status === "D" && !e.dir, (el) => el.line_through()).when(Boolean(fl?.bright), pulse).child(e.name + (e.link ? " ↪" : "")))
      .when(Boolean(meta), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(meta)))
      .when(Boolean(loc?.[0]), (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${loc[0]}`)))
      .when(Boolean(loc?.[1]), (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${loc[1]}`)))
      .when(Boolean(counts), (el) => el.children(this.countChips(counts, t)))
      .when(!counts && Boolean(status), (el) => el.child(div().flex_none().w(10).text_size(11).font_semibold().text_color(gc).child(status)))
      .when(!counts && !status && ignored, (el) => el.child(div().flex_none().w(10).text_size(11).text_color(t.dim).child("⊘")));
  }

  countChips(c, t) {
    const out = [];
    if (c[0]) out.push(div().flex_none().text_size(11).text_color(t.ansi2).child(`?:${c[0]}`));
    if (c[1]) out.push(div().flex_none().text_size(11).text_color(t.ansi11 ?? t.ansi3).child(`M:${c[1]}`));
    if (c[2]) out.push(div().flex_none().text_size(11).text_color(t.ansi1).child(`D:${c[2]}`));
    return out;
  }

  // Branch, totals, a bar of modified / new / deleted, and its legend.
  summary(t) {
    const g = this.git, b = g.branch, tone = tones(t);
    if (!g.top) return h_flex().h(28).flex_none().px(10).gap(6).items_center().text_size(11.5).text_color(t.dim)
      .child(div().truncate().child(this.root ? "± no git repo · git status starts after git init" : ""));
    const lit = this.branchFlash ? tone[this.branchFlash.tone] : null, totals = g.diff.get("") ?? [0, 0];
    const c = g.counts.get("") ?? [0, 0, 0], total = c[0] + c[1] + c[2];
    const parts = [[c[1], tone.yellow, "modified"], [c[0], tone.green, "new"], [c[2], tone.red, "deleted"]].filter(([n]) => n > 0);
    const room = Math.max(40, this.width - 20 - 2 * (parts.length - 1));
    return v_flex().flex_none().px(10).pt(9).pb(8).gap(6)
      .child(h_flex().gap(6).items_center().text_size(12)
        .child(svg(ICON("git-branch")).size(12).flex_none().text_color(lit ?? t.foreground))
        .child(div().min_w(0).truncate().font_medium().text_color(lit ?? t.foreground).when(Boolean(lit), (el) => el.loop("opacity", { from: 0.4, to: 1, period: 900 })).child(b?.head ?? "…"))
        .when(Boolean(b?.ahead), (el) => el.child(div().flex_none().text_color(tone.teal).child(`↑${b.ahead}`)))
        .when(Boolean(b?.behind), (el) => el.child(div().flex_none().text_color(tone.blue).child(`↓${b.behind}`)))
        .child(div().flex_1())
        .when(Boolean(totals[0]), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.ansi2).child(`+${totals[0]}`)))
        .when(Boolean(totals[1]), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.ansi1).child(`−${totals[1]}`))))
      .child(total
        ? h_flex().h(4).gap(2).children(parts.map(([n, color]) => div().h_full().w(Math.max(3, (room * n) / total)).bg(color)))
        : div().h(4).w_full().bg(t.raised))
      .child(h_flex().gap(12).items_center().text_size(11).text_color(t.dim)
        .when(!total, (el) => el.child(div().child("clean · nothing to commit")))
        .children(parts.map(([n, color, label]) => h_flex().flex_none().gap(4).items_center().child(div().size(7).bg(color)).child(`${n} ${label}`)))
        .child(div().flex_1().min_w(0).truncate().text_right().child(b?.upstream ?? "")));
  }

  footer(t) {
    const c = this.chip, tone = tones(t);
    if (!this.cursor && !c) return null;
    const color = c ? (c.state === "failed" ? tone.red : tone[c.tone] ?? t.accent) : null;
    const hash = c?.state === "done" ? c.detail.split(" ")[0] : "";
    return h_flex().h(24).flex_none().px(10).gap(8).items_center().text_size(11).border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child((() => {
        const k = parseKey(this.cursor), R = k ? this.ownerOf(k.rid) : null;
        return !this.cursor ? "" : !k ? this.cursor : R ? (k.head ? R.root : `${baseOf(R.root)}/${k.rel}`) : "";
      })()))
      .when(Boolean(c), (el) => el.child(h_flex().flex_none().gap(4).items_center().text_color(color)
        .child(div().when(c.state === "running", (d) => d.font_semibold().loop("opacity", { from: 0.4, to: 1, period: 1000 })).child(c.state === "running" ? `${c.label}…` : c.state === "done" ? `✓ ${c.label}` : c.label))
        .when(Boolean(hash), (d) => d.child(div().text_color(t.dim).child(hash)))));
  }

  renderMenu(cx) {
    const t = theme(), m = this.menu, R = frameLook().radius;
    const close = () => closeOverlay(props().overlay);
    const item = (id, label, act) => div().id(id).h(28).px(10).flex().items_center().rounded(R).cursor_pointer().text_size(12.5)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { close(); act(cx); }).child(label);
    const items = [];
    if (m.rootMenu) {
      items.push(item("m-term", "Open terminal here", () => { const sp = activeSpace(); run("tab.new", { space: sp?.id, folder: m.abs, name: baseOf(m.abs) }); }));
      items.push(item("m-reveal", window()?.platform === "macos" ? "Reveal in Finder" : "Show in folder", () => revealExternal(m.abs).catch(() => {})));
      items.push(item("m-abs", "Copy path", (cx) => copy(cx, m.abs)));
      if (!m.main) {
        items.push(div().h(1).my(4).bg(t.border));
        items.push(item("m-new-space", "Open as its own space", () => run("space.new", { folder: m.abs, machine: "" })));
        items.push(div().id("m-remove").h(28).px(10).flex().items_center().rounded(R).cursor_pointer().text_size(12.5).text_color(t.ansi1)
          .hover((s) => s.bg(t.hover)).on_click(() => { close(); if (m.space) removeSpaceFolder(m.space, m.abs, m.project); }).child("Remove folder from space"));
      }
      return v_flex().id("ft-menu").size_full().p(5).gap(0).bg(t.popover ?? t.surface).text_color(t.foreground).children(items);
    }
    if (!m.dir) items.push(item("m-preview", "Preview", () => setShared(`${NAME}.preview`, { root: m.root, rel: m.rel, n: Date.now() })));
    if (!m.dir && m.local) items.push(item("m-open", "Open in default app", () => openExternal(m.abs).catch((e) => notify({ title: "Could not open the file", body: String(e?.message ?? e), level: "error" }))));
    if (m.local) items.push(item("m-reveal", window()?.platform === "macos" ? "Reveal in Finder" : "Show in folder", () => revealExternal(m.abs).catch(() => {})));
    items.push(item("m-rel", "Copy relative path", (cx) => copy(cx, m.rel)));
    items.push(item("m-abs", "Copy absolute path", (cx) => copy(cx, m.abs)));
    items.push(item("m-send", "Send to agent", (cx) => sendToAgent(cx, m.abs)));
    return v_flex().id("ft-menu").size_full().p(5).gap(0).bg(t.popover ?? t.surface).text_color(t.foreground).children(items);
  }

  render(cx) {
    if (this.menu) return this.renderMenu(cx);
    this.sync(cx);
    this.syncRoots(cx);
    const req = shared(`${NAME}.preview`);
    if (req && req.n !== this.seenPreview) {
      this.seenPreview = req.n;
      const S = this.subList().find((x) => x.root === req.root);
      if (req.root === this.root) this.show(req.rel, cx, true);
      else if (S) this.show(`${baseOf(S.root)}/${req.rel}`, cx, true, join(S.root, req.rel));
    }
    // Another mod (session-bar's changed chip) asks for a view.
    const want = shared(`${NAME}.view`);
    if (want && want.n !== this.seenView) {
      this.seenView = want.n;
      if (VIEWS.some(([v]) => v === want.view) && want.view !== this.view) { this.view = want.view; this.hits = null; this.closePreview(); this.savePrefs(); }
    }
    // VNH: switching to another space shows the tree, not the Recent list you may have left on in the last one.
    { const sid = spaces().find((x) => x.active)?.id;
      if (this.lastSpace !== undefined && sid !== this.lastSpace && this.view !== "tree" && !this.file) { this.view = "tree"; this.hits = null; this.closePreview(); this.savePrefs(); }
      this.lastSpace = sid; }
    const t = theme(), look = frameLook(), R = look.radius, now = Date.now();
    const rows = this.file ? [] : this.rows();
    if (this.scrollTo !== null && this.scrollTo !== undefined) {
      const at = rows.findIndex((r) => r.rel === this.scrollTo);
      if (at >= 0) { this.scroll.scroll_to_item(at, "center"); this.scrollTo = null; }
      else if (!this.pending.size && !this.loading) this.scrollTo = null;
    }
    const title = this.file ?? (this.root ? baseOf(this.root) : "Files");
    const btn = (id, label, tip, on, fn) => this.button(id, label, tip, on, fn, t, R);
    const header = h_flex().h(look.header).flex_none().px(8).gap(4).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_size(12)
      .when(Boolean(this.file), (el) => el.child(btn("ft-back", svg(ICON("chevron-left")).size(12), "Back to the tree (Esc)", false, () => this.closePreview())))
      .when(Boolean(this.file), (el) => el.child(image(fileIcon(this.file, false, false, settings().dark !== false)).size(14).flex_none()))
      .child(div().flex_1().min_w(0).truncate().font_medium().text_color(this.file ? t.foreground : t.muted).child(title))
      .when(Boolean(this.file), (el) => el
        .when(!this.on, (el) => el.child(btn("ft-ext", "↗", "Open in default app (o)", false, () => openExternal(this.fileAbs ?? join(this.root, this.file)).catch(() => {}))))
        .child(btn("ft-copy", "⧉", "Copy path", false, (cx) => copy(cx, this.file)))
        .child(btn("ft-send", "@", "Send to agent", false, (cx) => sendToAgent(cx, this.fileAbs ?? join(this.root, this.file)))))
      .when(!this.file, (el) => el.child(h_flex().flex_none().gap(2).items_center().children(VIEWS.map(([id, label, icon], i) => {
        const on = this.view === id;
        return h_flex().id(`ft-tab-${id}`).h(22).px(7).gap(5).flex_none().items_center().rounded(R).cursor_pointer().text_size(11.5)
          .text_color(on ? t.foreground : t.dim).when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
          .tooltip(`${label} (${i + 1})`).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.setView(id, cx))
          .child(svg(ICON(icon)).size(12).flex_none())
          .when(on || this.width >= 300, (el) => el.child(label));
      }))));

    // Tools sit beside the filter box and change with the view.
    const tools = this.view === "tree" ? [
      btn("ft-up", "↑", "Up a folder", false, () => { if (!this.root) return; this.follow = false; this.pinned = this.root.replace(/[\\/][^\\/]+[\\/]?$/, "") || "/"; this.pinnedOn = this.on; }),
      btn("ft-home", "⌂", this.follow ? "Following the focused pane" : "Back to the focused pane's folder", this.follow, () => { this.follow = true; this.pinned = null; }),
      btn("ft-hidden", this.showHidden ? "◉" : "○", this.showHidden ? "Hide dotfiles (.)" : "Show dotfiles (.)", this.showHidden, () => { this.showHidden = !this.showHidden; this.savePrefs(); }),
      btn("ft-ignored", this.showIgnored ? "⊙" : "⊘", this.showIgnored ? "Hide git-ignored files and folders (i)" : "Show git-ignored files and folders (i)", this.showIgnored, () => { this.showIgnored = !this.showIgnored; this.savePrefs(); }),
      btn("ft-size", "Σ", this.showSize ? "Show dates" : "Show sizes", Boolean(this.showSize), () => { this.showSize = !this.showSize; this.savePrefs(); }),
      btn("ft-collapse", "⊟", "Collapse all", false, (cx) => this.collapseAll(cx)),
    ] : [
      btn("ft-agents", this.allAgents ? "∗" : "◎", this.allAgents ? "Showing every agent: show only the one in view" : "Showing the agent in view: show every agent", !this.allAgents, () => { this.allAgents = !this.allAgents; try { localStorage.setItem("allAgents", this.allAgents ? "1" : "0"); } catch {} }),
      btn("ft-forget", "⊘", "Clear the list", false, () => { this.history = []; try { localStorage.setItem("history", "[]"); } catch {} }),
    ];

    // VNH: in the side panel, a rounded, bordered card like the Changes panel's; a pane has Herdr's own frame.
    const inPanel = (() => { const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).reduce((h, c) => h ?? find(c, id), null)); return Boolean(find(layout(), "panel-body")?.children?.some((c) => c.content?.mod === NAME)); })();
    const root = v_flex().id(NAME).size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .when(inPanel, (el) => el.rounded(10).border_1().border_color(t.border))
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_drop((e, cx) => this.dropFolders(e.paths ?? [], cx))
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 4) { this.width = size.width; cx.notify(); } })
      .child(header);

    if (this.file) {
      return root.child(this.code ? Editor.new(this.code).flex_1().min_h(0)
        : this.md !== null ? div().id("ft-md").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(10).child(TextView.markdown("ft-md-text", this.md).selectable(true))
        : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"));
    }

    const q = this.query.trim();
    const note = this.error || (!this.root ? "No folder"
      : this.view === "recent" ? (rows.length ? null : q ? "No matches" : this.allAgents || !this.mine ? "Files Claude reads and writes here show up in this list" : "Nothing from this agent yet (∗ shows every agent)")
      : this.searching && !rows.length ? "Searching…" : this.hits ? (rows.length ? null : "No matches") : this.loading && !rows.length ? "Loading files…" : !rows.length ? "Empty folder" : null);
    return root
      .when(!this.subList().length, (el) => el.child(this.summary(t)))
      .child(h_flex().flex_none().mx(6).mt(6).mb(4).gap(2).items_center()
        .child(h_flex().flex_1().min_w(0).h(26).px(8).gap(6).items_center().rounded(R).bg(t.canvas ?? t.background).border_1().border_color(this.typing ? t.accent : t.input ?? t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(svg(ICON("search")).size(12).flex_none().text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground))
          .when(Boolean(this.query), (el) => el.child(div().id("ft-clear").flex_none().text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.clearSearch(cx)).child("×"))))
        .children(tools))
      .child(div().flex_1().min_h(0).relative().px(4)
        // VNH: the virtual list reports only which row was clicked; this says whether it was on the
        // eye at the row's right end (its last ~30 px: 4 px padding, 10 px row padding, the 16 px eye).
        // Window position less the box's left edge: both are window pixels whatever local_position means.
        .on_mouse_down("left", (e) => { const x = e.position?.x, left = e.bounds?.x; this.downX = typeof x === "number" && typeof left === "number" ? x - left : (e.local_position?.x ?? null); this.downW = e.bounds?.width ?? null; })
        .child(v_virtual_list("ft-rows", rows.length, ROW, (i) => rows[i]?.rel ?? String(i), (range) => {
          const shown = rows.slice(range.start, range.end);
          this.visible = shown.filter((r) => !r.flat && !r.head && !r.owner && r.e?.dir).map((r) => r.rel);
          for (const S of this.subList()) S.visible = shown.filter((r) => !r.flat && r.owner === S && r.e?.dir).map((r) => r.local);
          return shown.map((r) => this.row(r, t, R, now));
        }).track_scroll(this.scroll).size_full()
          .on_item_click((rel, cx) => this.press(rel, cx))
          .on_item_secondary_click((rel, _e, cx) => {
            const r = this.rows().find((x) => x.rel === rel); if (!r) return;
            this.cursor = rel;
            if (r.head) this.openRootMenu(r.owner);
            else if (r.owner && r.owner !== this) r.owner.openMenu(r.local, r.e.dir);
            else this.openMenu(rel, r.e.dir);
            cx.notify();
          }))
        .child(Scrollbar.vertical("ft-rows").viewport_from_layout().absolute().inset_0())
        .when(Boolean(note), (el) => el.child(div().absolute().top(4).left(0).right(0).px(10).text_size(12).text_color(t.dim).child(note))))
      .when(this.limited, (el) => el.child(div().px(10).py(3).text_size(11).text_color(t.dim).child(`Folders show their first ${PER_FOLDER} entries`)))
      .when(Boolean(this.hits?.length >= FIND_LIMIT), (el) => el.child(div().px(10).py(3).text_size(11).text_color(t.dim).child(`First ${FIND_LIMIT} matches · Enter jumps to the selected one`)))
      .when(Boolean(this.cursor || this.chip), (el) => el.child(this.footer(t)));
  }
}

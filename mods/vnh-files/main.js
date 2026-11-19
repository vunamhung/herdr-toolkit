// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000, EXPAND_FOLDERS = 200;

// "980 B" / "12.3 KB" / "4.0 MB".
function fmtSize(n) {
  if (!(n >= 0)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return i === 0 ? `${n} B` : `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

const SORTS = [["name", "Sort by Name"], ["type", "Sort by Type"], ["mtime", "Sort by Modification Time"]];
const ext = (name) => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1).toLowerCase() : ""; };

// Folders first, then by the chosen key; ties by name.
function sortEntries(list, by) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  return list.sort((a, b) => Number(b.dir) - Number(a.dir)
    || (by === "type" && !a.dir ? ext(a.name).localeCompare(ext(b.name)) : 0)
    || (by === "mtime" ? (b.mtime ?? 0) - (a.mtime ?? 0) : 0)
    || byName(a, b));
}

// Git decorations as in VS Code: U untracked, A added, M modified, D deleted, ! conflict.
// A folder takes the most severe status below it.
const SEVERITY = { "!": 5, M: 4, D: 3, A: 2, U: 1 };
function gitMark(xy) {
  if (xy === "??") return "U";
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "!";
  if (xy[0] === "A") return "A";
  if (xy.includes("D")) return "D";
  return "M";
}
function markColor(t, mark) {
  return mark === "U" || mark === "A" ? t.ansi2 : mark === "M" ? t.ansi3 : mark === "D" || mark === "!" ? t.ansi1 : null;
}

// `git diff -U0` hunks as VS Code's change markers: added / modified line ranges (1-based, in the
// working file) and "deleted" points (lines removed after line `start`).
function parseHunks(diff) {
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

// A folder's first-level contents: "3 folders · 12 files".
function fmtCounts(dirs, files) {
  const part = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return [dirs ? part(dirs, "folder", "folders") : "", files ? part(files, "file", "files") : ""].filter(Boolean).join(" · ") || "empty";
}

async function directory(path, on, sizes = false, mtimes = false) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  // With sizes ("1"): a file's byte size (GNU stat, else BSD stat), a folder's first-level
  // "<folders> <files>" (not counting .git). Without, the third field stays empty.
  // With mtimes ("1"): the 4th field is the modification time in unix seconds, else empty.
  const script = 'root=$1; sz=$2; mt=$3; n=0; for p in "$root"/* "$root"/.[!.]* "$root"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; info=; if [ -d "$p" ]; then kind=d; if [ "$sz" = 1 ]; then d=0; f=0; for q in "$p"/* "$p"/.[!.]* "$p"/..?*; do [ -e "$q" ] || [ -L "$q" ] || continue; [ "${q##*/}" = .git ] && continue; if [ -d "$q" ]; then d=$((d+1)); else f=$((f+1)); fi; done; info="$d $f"; fi; else kind=f; if [ "$sz" = 1 ]; then info=$(stat -c %s "$p" 2>/dev/null || stat -f %z "$p" 2>/dev/null); fi; fi; m=; if [ "$mt" = 1 ]; then m=$(stat -c %Y "$p" 2>/dev/null || stat -f %m "$p" 2>/dev/null); fi; printf "%s\\0%s\\0%s\\0%s\\0" "$kind" "$name" "$info" "$m"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$root"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path, sizes ? "1" : "0", mtimes ? "1" : "0"], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const entry = { name: fields[i + 1], dir: fields[i] === "d" }, info = fields[i + 2];
    if (fields[i + 3]) entry.mtime = Number(fields[i + 3]);
    if (info && entry.dir) { const [d, f] = info.split(" ").map(Number); entry.counts = { dirs: d || 0, files: f || 0 }; }
    else if (info) entry.size = Number(info);
    out.push(entry);
  }
  return out;
}

// Lists several folders with ONE shell call (plus one `stat` call when sizes or times are shown),
// so the work per refresh does not grow with the number of open folders.
// Returns Map<absolute folder, entries | null (missing)>.
const LIST_SCRIPT = 'sz=$1; shift; for root in "$@"; do printf "\\001%s\\0" "$root"; [ -d "$root" ] || { printf "\\002\\0"; continue; }; n=0; for p in "$root"/* "$root"/.[!.]* "$root"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; info=; if [ -d "$p" ]; then kind=d; if [ "$sz" = 1 ]; then d=0; f=0; for q in "$p"/* "$p"/.[!.]* "$p"/..?*; do [ -e "$q" ] || [ -L "$q" ] || continue; [ "${q##*/}" = .git ] && continue; if [ -d "$q" ]; then d=$((d+1)); else f=$((f+1)); fi; done; info="$d $f"; fi; else kind=f; fi; printf "%s\\0%s\\0%s\\0" "$kind" "$name" "$info"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; done';
// "size mtime path" per line; GNU or BSD stat, whichever this machine has.
const STAT_SCRIPT = 'if stat -c %s / >/dev/null 2>&1; then stat -c "%s %Y %n" -- "$@"; else stat -f "%z %m %N" -- "$@"; fi 2>/dev/null; true';
const CHUNK = 1500;

async function listFolders(paths, on, sizes, mtimes) {
  const out = new Map();
  if (!paths.length) return out;
  const oneByOne = async () => { for (const p of paths) out.set(p, await directory(p, on).catch(() => null)); return out; };
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
    for (let k = 0; k < want.length; k += CHUNK) {
      const part = want.slice(k, k + CHUNK);
      const st = await exec("sh", ["-c", STAT_SCRIPT, "stat", ...part.map(([p]) => p)], { on }).catch(() => null);
      const byPath = new Map();
      for (const line of (st?.stdout ?? "").split("\n")) {
        const a = line.indexOf(" "), b = line.indexOf(" ", a + 1);
        if (a > 0 && b > a) byPath.set(line.slice(b + 1), [Number(line.slice(0, a)), Number(line.slice(a + 1, b))]);
      }
      for (const [p, e] of part) {
        const v = byPath.get(p);
        if (!v) continue;
        if (sizes && !e.dir) e.size = v[0];
        if (mtimes) e.mtime = v[1];
      }
    }
  }
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.ignored = new Set(); // paths (relative to the root) that .gitignore ignores
    const flag = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === "1"; } catch { return d; } };
    this.showIgnored = flag("showIgnored", true);
    this.showSizes = flag("showSizes", false);
    try { const v = localStorage.getItem("sortBy"); this.sortBy = SORTS.some(([k]) => k === v) ? v : "name"; } catch { this.sortBy = "name"; }
    this.sortOpen = false;
    this.refresh(cx);
    // Refresh every 10 s, but only while the Herdr window is active; changes seen while it is in
    // the background (agents keep writing files) are caught up once it becomes active again.
    cx.timer.every(2000, cx => {
      if (!window()?.active) return;
      if (this.stale || Date.now() - (this.refreshedAt ?? 0) >= 10000) this.refresh(cx);
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        while (this.context === context) {
          await watchFolder(root);
          if (!this.current(context)) continue;
          if (window()?.active) this.refresh(cx); else this.stale = true;
        }
      }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  loadFolder(path, context) {
    return this.loadFolders([path], context);
  }

  // Loads folders (paths relative to the root, "" = the root) with one listing call and one
  // `git check-ignore` call for all of them.
  async loadFolders(paths, context) {
    const { on, cwd: root } = context;
    const abs = (p) => (p ? `${root}/${p}` : root);
    const listed = await listFolders(paths.map(abs), on, this.showSizes, this.sortBy === "mtime");
    if (!this.current(context)) return;
    if (listed.get(root) === null) throw new Error("Cannot list this folder");
    const fresh = [];
    for (const path of paths) {
      const entries = listed.get(abs(path));
      if (path && !this.folders.has(path)) continue;
      if (!entries) { if (path) { this.folders.delete(path); this.entries.delete(path); } continue; } // gone
      fresh.push([path, entries]);
    }
    // Which entries .gitignore ignores (relative to the panel's folder; folders end in "/").
    // No -z: git only allows it with --stdin, and exec has no stdin. quotePath off keeps
    // non-ASCII names as typed; exit 1 means none ignored, 128 not a repo.
    const asked = fresh.flatMap(([path, entries]) => entries.slice(0, PER_FOLDER).map((e) => `${path ? path + "/" : ""}${e.name}${e.dir ? "/" : ""}`));
    for (let k = 0; k < asked.length; k += CHUNK) {
      const part = asked.slice(k, k + CHUNK);
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "check-ignore", "--", ...part], { cwd: root, on }).catch(() => null);
      if (!this.current(context)) return;
      const hit = new Set(r && (r.code === 0 || r.code === 1) ? r.stdout.split("\n").filter(Boolean) : []);
      for (const p of part) { const key = p.replace(/\/$/, ""); if (hit.has(p)) this.ignored.add(key); else this.ignored.delete(key); }
    }
    for (const [path, entries] of fresh) {
      const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
      this.entries.set(path, sortEntries(entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))), this.sortBy));
      if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
    }
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.folderMarks = {}; this.ignored = new Set(); this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.stale = false;
    this.refreshedAt = Date.now();
    this.limited = false;
    cx.spawn(async cx => {
      try {
        await this.loadFolders(["", ...this.folders], context);
        if (!this.current(context)) return;
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {}, folderMarks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            const repo = top.stdout.trim(), mark = gitMark(xy);
            let file = `${repo}/${entry.slice(3)}`;
            if (file.endsWith("/")) file = file.slice(0, -1); // an untracked folder shown as one entry
            marks[file] = mark;
            // Every folder above it, up to the repo, shows the most severe status inside.
            for (let dir = file.slice(0, file.lastIndexOf("/")); dir.length > repo.length; dir = dir.slice(0, dir.lastIndexOf("/"))) {
              if ((SEVERITY[folderMarks[dir]] ?? 0) >= SEVERITY[mark]) break;
              folderMarks[dir] = mark;
            }
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.folderMarks = folderMarks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  setFlag(name, value, cx) {
    this[name] = value;
    try { localStorage.setItem(name, value ? "1" : "0"); } catch {}
    if (name === "showSizes") this.refresh(cx); // re-list loaded folders with or without sizes
    cx.notify();
  }

  setSort(by, cx) {
    this.sortOpen = false;
    if (by !== this.sortBy) {
      this.sortBy = by;
      try { localStorage.setItem("sortBy", by); } catch {}
      // Name/type re-sort what is loaded; modification time needs the folders listed again with times.
      const haveTimes = [...this.entries.values()].every((l) => l.every((e) => e.mtime != null));
      if (by === "mtime" && !haveTimes) this.refresh(cx);
      else for (const [p, l] of this.entries) this.entries.set(p, sortEntries(l, by));
    }
    cx.notify();
  }

  collapseAll(cx) {
    this.folders = new Set();
    for (const p of [...this.entries.keys()]) if (p) this.entries.delete(p);
    cx.notify();
  }

  // Opens every folder below the root, breadth first, but never an ignored one (node_modules,
  // build output): at most EXPAND_FOLDERS folders and TOTAL entries.
  expandAll(cx) {
    if (this.expanding) return;
    const context = this.context;
    this.expanding = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        // Level by level: each level's folders are listed with one batched call.
        let level = [""], opened = 0;
        while (level.length && opened < EXPAND_FOLDERS) {
          const missing = level.filter((p) => !this.entries.has(p));
          if (missing.length) await this.loadFolders(missing, context);
          if (!this.current(context)) return;
          const next = [];
          for (const parent of level) {
            for (const e of this.entries.get(parent) ?? []) {
              if (!e.dir || opened >= EXPAND_FOLDERS) continue;
              const p = parent ? `${parent}/${e.name}` : e.name;
              if (this.ignored.has(p)) continue;
              this.folders.add(p);
              next.push(p);
              opened++;
            }
          }
          if ([...this.entries.values()].reduce((n, l) => n + l.length, 0) >= TOTAL) { this.limited = true; break; }
          cx.notify();
          level = next;
        }
        const unloaded = level.filter((p) => !this.entries.has(p));
        if (unloaded.length && this.current(context)) await this.loadFolders(unloaded, context);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.expanding = false; cx.notify(); }
    });
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    this.fileHunks = []; this.fileLines = 0; this.lineStarts = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        const value = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        // Line start offsets (UTF-16, as the editor's selection uses) for jumping to a change.
        const starts = [0];
        for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) starts.push(i + 1);
        this.lineStarts = starts; this.fileLines = starts.length;
        // Changes against HEAD for the overview ruler; an untracked file is all added.
        const mark = this.marks[`${root}/${path}`];
        if (mark === "U") this.fileHunks = [{ kind: "added", start: 1, count: starts.length }];
        else if (mark) {
          const d = await exec("git", ["--no-optional-locks", "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "-U0", "HEAD", "--", path], { cwd: root, on }).catch(() => null);
          if (this.file !== path || !this.current(context)) return;
          this.fileHunks = d?.code === 0 ? parseHunks(d.stdout) : [];
        }
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const ignored = this.ignored.has(path);
      if (ignored && !this.showIgnored) continue;
      // A folder's own mark (an untracked folder) or the most severe one inside it.
      const folderMark = entry.dir ? (mark ?? this.folderMarks?.[`${this.root}/${path}`]) : null;
      const color = ignored ? t.dim : markColor(t, entry.dir ? folderMark : mark);
      const meta = !this.showSizes ? "" : entry.dir ? (entry.counts ? fmtCounts(entry.counts.dirs, entry.counts.files) : "") : fmtSize(entry.size);
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        // Drag a file or folder into a terminal: locally it types `@<path>` relative to this
        // panel's folder (the focused terminal's), which Claude Code reads as a file mention;
        // a folder ends in `/`. On another machine it stays the absolute path (Herdr copies those).
        .drag_paths([this.on ? `${this.root}/${path}` : `@${path}${entry.dir ? "/" : ""}`], { on: this.on ?? null })
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/vnh-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/vnh-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(entry.dir && color ? color : t.muted))
        .child(div().flex_1().min_w(0).truncate().when(Boolean(color), el => el.text_color(color)).child(entry.name))
        .when(Boolean(meta), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(meta)))
        .when(!entry.dir && Boolean(mark), el => el.child(div().flex_none().w(12).text_size(11).text_color(markColor(t, mark)).child(mark)))
        .when(entry.dir && Boolean(folderMark) && !ignored, el => el.child(div().flex_none().w(12).text_size(11).text_color(markColor(t, folderMark)).child("•"))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  openMarkdown() {
    if (!this.file || !this.root) return;
    const space = spaces().find(s => s.active)?.id;
    run("tab.new", { space, name: this.file.split("/").pop(), mod: "vnh-markdown", props: { path: `${this.root}/${this.file}`, on: this.on ?? null } });
  }

  // A 24 px icon button in the header; `on` highlights a toggle that is active.
  tool(t, id, icon, label, on, action) {
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, el => el.bg(t.selected)).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(label).on_click((_e, cx) => action(cx)).child(svg(`mods/vnh-files/${icon}.svg`).size(14));
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    // The header's buttons show only while the pointer is over the panel (space kept, nothing shifts).
    return v_flex().id("files").relative().size_full().min_h(0).rounded(10).overflow_hidden()
      .on_hover((hovered, cx) => { if (this.panelHover !== hovered) { this.panelHover = hovered; cx.notify(); } }).bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().id("files-header").h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        // VNH: the folder's name is the title (no "Files"); a previewed file's path stays on the right.
        .child(div().flex_none().max_w(200).truncate().font_semibold().child(this.root?.split(/[\\/]/).pop() || "Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? ""))
        // A Markdown file: the eye opens it rendered in a new tab (vnh-markdown).
        .when(Boolean(this.file) && /\.(md|markdown|mdx)$/i.test(this.file), el => el.child(
          this.tool(t, "files-md-open", "eye", "Open rendered Markdown in a new tab", false, () => this.openMarkdown())))
        .when(!this.file, el => el.child(h_flex().flex_none().gap(2).items_center().when(!this.panelHover && !this.sortOpen, el => el.invisible())
          .child(this.tool(t, "files-sort", "sort", "Sort", this.sortOpen, (cx) => {
            // The click that closed the menu (outside it) is this same press: don't reopen.
            if (!this.sortOpen && Date.now() - (this.sortClosedAt ?? 0) < 250) return;
            this.sortOpen = !this.sortOpen; cx.notify();
          }))
          .child(this.tool(t, "files-ignored", this.showIgnored ? "eye" : "eye-off", this.showIgnored ? "Hide ignored files" : "Show ignored files", !this.showIgnored, (cx) => this.setFlag("showIgnored", !this.showIgnored, cx)))
          .child(this.tool(t, "files-sizes", "ruler", this.showSizes ? "Hide sizes" : "Show sizes", this.showSizes, (cx) => this.setFlag("showSizes", !this.showSizes, cx)))
          .child(this.tool(t, "files-expand", "expand-all", this.expanding ? "Expanding…" : "Expand all", this.expanding, (cx) => this.expandAll(cx)))
          .child(this.tool(t, "files-collapse", "collapse-all", "Collapse all", false, (cx) => this.collapseAll(cx))))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code
        ? h_flex().flex_1().min_h(0).child(Editor.new(this.code).flex_1().min_w(0).min_h(0)).when(this.fileHunks.length > 0, el => el.child(this.ruler(t)))
        : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")))
      .when(this.sortOpen && !this.file, el => el.child(this.sortMenu(t)));
  }

  // VS Code style overview ruler beside the preview: where the file's uncommitted changes are,
  // relative to its length (green added, blue modified, red removed). Click one to put the
  // editor's cursor on that line.
  ruler(t) {
    const total = Math.max(1, this.fileLines), pct = (n) => `${Math.min(100, Math.max(0, n * 100))}%`;
    const color = { added: t.ansi2, modified: t.ansi4, deleted: t.ansi1 };
    return div().id("files-ruler").relative().w(10).flex_none().h_full().border_l(1).border_color(t.border)
      .children(this.fileHunks.slice(0, 400).map((h, i) => {
        const top = (h.kind === "deleted" ? h.start : h.start - 1) / total;
        return div().id(`files-ruler-${i}`).absolute().left(2).w(6).top(pct(top)).min_h(3).rounded(1)
          .when(h.count > 0, el => el.h(pct(h.count / total))).when(h.count === 0, el => el.h(3))
          .bg(color[h.kind]).cursor_pointer()
          .tooltip(h.kind === "deleted" ? `Removed after line ${h.start}` : `${h.kind === "added" ? "Added" : "Modified"} line${h.count > 1 ? `s ${h.start}–${h.start + h.count - 1}` : ` ${h.start}`}`)
          .on_click((_e, cx) => this.jumpTo(h.kind === "deleted" ? h.start + 1 : h.start, cx));
      }));
  }

  jumpTo(line, cx) {
    if (!this.code || !this.lineStarts) return;
    const at = this.lineStarts[Math.min(this.lineStarts.length, Math.max(1, line)) - 1] ?? 0;
    this.code.focus();
    this.code.set_selected_range({ start: at, end: at });
    cx.notify();
  }

  // The Sort dropdown under the header's buttons; a click outside closes it.
  sortMenu(t) {
    return v_flex().id("files-sort-menu").absolute().top(38).right(8).w(230).p(4).gap(1).rounded(8)
      .bg(t.surface).border_1().border_color(t.border).text_size(13)
      .on_mouse_down_out((_e, cx) => { if (this.sortOpen) { this.sortOpen = false; this.sortClosedAt = Date.now(); cx.notify(); } })
      .children(SORTS.map(([by, label]) => h_flex().id(`files-sort-${by}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.setSort(by, cx))
        .child(by === this.sortBy ? svg("mods/vnh-files/check.svg").size(14).flex_none() : div().w(14).flex_none())
        .child(div().child(label))));
  }
}

// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window } from "herdr";

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

// A folder's first-level contents: "3 folders · 12 files".
function fmtCounts(dirs, files) {
  const part = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return [dirs ? part(dirs, "folder", "folders") : "", files ? part(files, "file", "files") : ""].filter(Boolean).join(" · ") || "empty";
}

async function directory(path, on, sizes = false) {
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
  const script = 'root=$1; sz=$2; n=0; for p in "$root"/* "$root"/.[!.]* "$root"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; info=; if [ -d "$p" ]; then kind=d; if [ "$sz" = 1 ]; then d=0; f=0; for q in "$p"/* "$p"/.[!.]* "$p"/..?*; do [ -e "$q" ] || [ -L "$q" ] || continue; [ "${q##*/}" = .git ] && continue; if [ -d "$q" ]; then d=$((d+1)); else f=$((f+1)); fi; done; info="$d $f"; fi; else kind=f; if [ "$sz" = 1 ]; then info=$(stat -c %s "$p" 2>/dev/null || stat -f %z "$p" 2>/dev/null); fi; fi; printf "%s\\0%s\\0%s\\0" "$kind" "$name" "$info"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$root"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path, sizes ? "1" : "0"], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const entry = { name: fields[i + 1], dir: fields[i] === "d" }, info = fields[i + 2];
    if (info && entry.dir) { const [d, f] = info.split(" ").map(Number); entry.counts = { dirs: d || 0, files: f || 0 }; }
    else if (info) entry.size = Number(info);
    out.push(entry);
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
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on, this.showSizes);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    // Which of these .gitignore ignores (paths relative to the panel's folder; folders end in "/").
    const rel = (e) => `${path ? path + "/" : ""}${e.name}${e.dir ? "/" : ""}`;
    const asked = entries.slice(0, PER_FOLDER).map(rel);
    if (asked.length) {
      // No -z: git only allows it with --stdin, and exec has no stdin. quotePath off keeps
      // non-ASCII names as typed; exit 1 means none ignored, 128 not a repo.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "check-ignore", "--", ...asked], { cwd: root, on }).catch(() => null);
      if (!this.current(context)) return;
      const hit = new Set(r && (r.code === 0 || r.code === 1) ? r.stdout.split("\n").filter(Boolean) : []);
      for (const p of asked) { const k = p.replace(/\/$/, ""); if (hit.has(p)) this.ignored.add(k); else this.ignored.delete(k); }
    }
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.ignored = new Set(); this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
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
        const queue = [""];
        let opened = 0;
        while (queue.length && opened < EXPAND_FOLDERS) {
          const parent = queue.shift();
          if (!this.entries.has(parent)) await this.loadFolder(parent, context);
          if (!this.current(context)) return;
          for (const e of this.entries.get(parent) ?? []) {
            if (!e.dir) continue;
            const p = parent ? `${parent}/${e.name}` : e.name;
            if (this.ignored.has(p)) continue;
            if ([...this.entries.values()].reduce((n, l) => n + l.length, 0) >= TOTAL) { this.limited = true; queue.length = 0; break; }
            this.folders.add(p);
            queue.push(p);
            if (++opened >= EXPAND_FOLDERS) break;
          }
          cx.notify();
        }
        for (const p of queue) if (!this.entries.has(p) && this.current(context)) await this.loadFolder(p, context);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.expanding = false; cx.notify(); }
    });
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
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
      const meta = !this.showSizes ? "" : entry.dir ? (entry.counts ? fmtCounts(entry.counts.dirs, entry.counts.files) : "") : fmtSize(entry.size);
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        // Drag a file or folder into a terminal: locally it types `@<path>` relative to this
        // panel's folder (the focused terminal's), which Claude Code reads as a file mention;
        // a folder ends in `/`. On another machine it stays the absolute path (Herdr copies those).
        .drag_paths([this.on ? `${this.root}/${path}` : `@${path}${entry.dir ? "/" : ""}`], { on: this.on ?? null })
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/vnh-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/vnh-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().when(ignored, el => el.text_color(t.dim)).child(entry.name))
        .when(Boolean(meta), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(meta)))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
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
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        // VNH: the folder's name is the title (no "Files"); a previewed file's path stays on the right.
        .child(div().flex_none().max_w(200).truncate().font_semibold().child(this.root?.split(/[\\/]/).pop() || "Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? ""))
        .when(!this.file, el => el.child(h_flex().flex_none().gap(2).items_center()
          .child(this.tool(t, "files-ignored", this.showIgnored ? "eye" : "eye-off", this.showIgnored ? "Hide ignored files" : "Show ignored files", !this.showIgnored, (cx) => this.setFlag("showIgnored", !this.showIgnored, cx)))
          .child(this.tool(t, "files-sizes", "ruler", this.showSizes ? "Hide sizes" : "Show sizes", this.showSizes, (cx) => this.setFlag("showSizes", !this.showSizes, cx)))
          .child(this.tool(t, "files-expand", "expand-all", this.expanding ? "Expanding…" : "Expand all", this.expanding, (cx) => this.expandAll(cx)))
          .child(this.tool(t, "files-collapse", "collapse-all", "Collapse all", false, (cx) => this.collapseAll(cx))))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}

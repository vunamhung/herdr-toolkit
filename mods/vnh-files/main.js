// VNH Files panel: a lazy file browser for the focused terminal's folder.
//
// Tree (virtual list): git colors as in VS Code, ignored files dimmed or hidden, sizes, sort,
// expand/collapse all, a "Recent changes" section (git-changed files edited in the last 15 min),
// drag rows into a terminal as @path, right-click menu (vnh-files-menu).
// Filters: search by name (/ or ⌘F; empty box = recently viewed files), changed files only.
// Preview: syntax-highlighted text with a change ruler, diff against HEAD, images, editing
// (⌘S saves), a clickable breadcrumb; Markdown opens rendered in a tab (eye / Space).
// Keys while the panel has the keyboard: ↑↓ move, → open / into, ← close / up, Enter open,
// Space quick-look (Markdown) or preview, Esc back, / search.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { readTextFile, writeTextFile, watchFolder, theme, settings, window, run, checking, nextCommand, openOverlay, notify, spaces, focused, exec, appHome, setShared, panes } from "herdr";
import {
  location, locationKey, rememberWorkFolder, PER_FOLDER, TOTAL, EXPAND_FOLDERS, CHUNK, LANG, IMAGE, MARKDOWN,
  ext, base, parent, fmtSize, fmtCounts, ago, alpha, SORTS, sortEntries, markColor, parseStatus, parseHunks,
  diffLines, git, listFolders, statPaths, listAllFiles, searchFiles,
} from "./lib.js";

const ROW = 28, DIFF_ROW = 19, RECENT_MIN = 15, RECENT_MAX = 8, RECENT_VIEWED = 15;
const key = locationKey;

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

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {}; this.folderMarks = {};
    this.ignored = new Set(); // paths (relative to the root) that .gitignore ignores
    const flag = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === "1"; } catch { return d; } };
    this.showIgnored = flag("showIgnored", true);
    this.showSizes = flag("showSizes", false);
    this.changedOnly = flag("changedOnly", false);
    this.recentOpen = flag("recentOpen", true);
    try { const v = localStorage.getItem("sortBy"); this.sortBy = SORTS.some(([k]) => k === v) ? v : "name"; } catch { this.sortBy = "name"; }
    this.sortOpen = false;
    this.recentChanged = [];
    this.cursor = null; // key of the keyboard-selected row
    this.range = { start: 0, end: 0 };
    this.listScroll = VirtualListScrollHandle.new();
    this.diffScroll = VirtualListScrollHandle.new();
    this.search = { open: false, query: "", files: null, at: 0, key: null };
    this.input = InputState.new({ placeholder: "Search files by name…" });
    this.input.on("change", (_e, cx) => { this.search.query = this.input.value(); this.cursor = null; this.loadAllFiles(cx); cx.notify(); });
    this.input.on("submit", (_e, cx) => { const it = this.items()[Math.max(0, this.cursorIndex())]; if (it) this.activate(it, cx); });
    if (!checking()) { rememberWorkFolder(); cx.timer.every(1000, () => rememberWorkFolder()); }
    // Keyboard: the panel takes it when clicked, or when the Markdown tab hands it back
    // ("vnh-files.focus"); the menu asks for a refresh after file operations ("vnh-files.refresh").
    this.kb = cx.focus_handle();
    if (!checking()) cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.kb.focus();
        else if (c === "refresh") this.refresh(cx);
        cx.notify();
      }
    });
    this.refresh(cx);
    // Refresh every 10 s, but only while the Herdr window is active; changes seen while it is in
    // the background (agents keep writing files) are caught up once it becomes active again.
    cx.timer.every(2000, (cx) => {
      if (!window()?.active) return;
      if (this.stale || Date.now() - (this.refreshedAt ?? 0) >= 10000) this.refresh(cx);
    });
  }

  // ------------------------------------------------------------------ loading

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        while (this.context === context) {
          await watchFolder(root);
          if (!this.current(context)) continue;
          if (window()?.active) this.refresh(cx); else this.stale = true;
        }
      } catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) { return this.context === context && key() === context.key; }

  loadFolder(path, context) { return this.loadFolders([path], context); }

  // Loads folders (relative to the root, "" = the root) with one listing call and one
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
    // Which entries .gitignore ignores. No -z: git only allows it with --stdin, and exec has no
    // stdin. Exit 1 means none ignored, 128 not a repo.
    const asked = fresh.flatMap(([path, entries]) => entries.slice(0, PER_FOLDER).map((e) => `${path ? path + "/" : ""}${e.name}${e.dir ? "/" : ""}`));
    for (let k = 0; k < asked.length; k += CHUNK) {
      const part = asked.slice(k, k + CHUNK);
      const r = await git(root, on, ["check-ignore", "--", ...part]);
      if (!this.current(context)) return;
      const hit = new Set(r && (r.code === 0 || r.code === 1) ? r.stdout.split("\n").filter(Boolean) : []);
      for (const p of part) { const k2 = p.replace(/\/$/, ""); if (hit.has(p)) this.ignored.add(k2); else this.ignored.delete(k2); }
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
      this.pending = new Set(); this.marks = {}; this.folderMarks = {}; this.ignored = new Set(); this.recentChanged = [];
      this.inRepo = false; this.show(null); this.watched = null; this.error = null; this.limited = false; this.cursor = null;
      this.search.files = null; this.search.key = null; this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.stale = false;
    this.refreshedAt = Date.now();
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        await this.loadFolders(["", ...this.folders], context);
        if (!this.current(context)) return;
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        let marks = {}, folderMarks = {}, recent = [];
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await git(cwd, on, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
          if (status?.code === 0) ({ marks, folderMarks } = parseStatus(status.stdout, top.stdout.trim()));
          // Recent changes: the changed files below the root edited in the last RECENT_MIN minutes.
          const mine = Object.keys(marks).filter((p) => p.startsWith(cwd + "/")).slice(0, 400);
          if (mine.length) {
            const st = await statPaths(mine, on);
            const since = Date.now() / 1000 - RECENT_MIN * 60;
            recent = mine.map((p) => ({ path: p.slice(cwd.length + 1), mtime: st.get(p)?.mtime ?? 0 }))
              .filter((x) => x.mtime >= since).sort((a, b) => b.mtime - a.mtime).slice(0, RECENT_MAX);
          }
        }
        if (!this.current(context)) return;
        this.inRepo = top?.code === 0;
        this.marks = marks; this.folderMarks = folderMarks; this.recentChanged = recent; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  // Every file name for search, cached 30 s.
  loadAllFiles(cx) {
    if (!this.search.open || !this.root || this.search.loading) return;
    if (this.search.files && this.search.key === this.context?.key && Date.now() - this.search.at < 30000) return;
    const context = this.context;
    this.search.loading = true;
    cx.spawn(async (cx) => {
      try {
        const files = await listAllFiles(context.cwd, context.on, this.inRepo);
        if (this.current(context)) Object.assign(this.search, { files, at: Date.now(), key: context.key });
      } finally { this.search.loading = false; cx.notify(); }
    });
  }

  // ------------------------------------------------------------------ tree actions

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else this.openFolders([path], cx);
    cx.notify();
  }

  // Opens folders (and loads the ones not loaded yet) in one batch.
  openFolders(paths, cx, then) {
    for (const p of paths) this.folders.add(p);
    const missing = paths.filter((p) => !this.entries.has(p) && !this.pending.has(p));
    if (!missing.length) { then?.(); return; }
    const context = this.context;
    for (const p of missing) this.pending.add(p);
    cx.spawn(async (cx) => {
      try { await this.loadFolders(missing, context); then?.(); }
      catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) for (const p of missing) this.pending.delete(p); cx.notify(); }
    });
  }

  // Shows `path` (a file or folder, relative to the root) in the tree: opens its folders, closes
  // the preview and the filters, puts the cursor on it and scrolls to it.
  reveal(path, cx) {
    this.show(null);
    this.search.open = false; this.changedOnly = false;
    const chain = [];
    for (let p = parent(path); p; p = parent(p)) chain.unshift(p);
    this.openFolders(chain, cx, () => {
      this.cursor = `e:${path}`;
      const i = this.cursorIndex();
      if (i >= 0) this.listScroll.scroll_to_item(i, "center");
      cx.notify();
    });
    cx.notify();
  }

  setFlag(name, value, cx) {
    this[name] = value;
    try { localStorage.setItem(name, value ? "1" : "0"); } catch {}
    if (name === "showSizes") this.refresh(cx); // re-list loaded folders with or without sizes
    this.cursor = null;
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

  // Opens every folder below the root, level by level (one batched listing per level), never an
  // ignored one (node_modules, build output): at most EXPAND_FOLDERS folders and TOTAL entries.
  expandAll(cx) {
    if (this.expanding) return;
    const context = this.context;
    this.expanding = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        let level = [""], opened = 0;
        while (level.length && opened < EXPAND_FOLDERS) {
          const missing = level.filter((p) => !this.entries.has(p));
          if (missing.length) await this.loadFolders(missing, context);
          if (!this.current(context)) return;
          const next = [];
          for (const par of level) {
            for (const e of this.entries.get(par) ?? []) {
              if (!e.dir || opened >= EXPAND_FOLDERS) continue;
              const p = par ? `${par}/${e.name}` : e.name;
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

  openSearch(cx) {
    this.search.open = true;
    this.cursor = null;
    this.loadAllFiles(cx);
    this.input.focus();
    cx.notify();
  }

  closeSearch(cx) {
    this.search.open = false;
    this.search.query = "";
    this.input.set_value("");
    this.cursor = null;
    this.kb.focus();
    cx.notify();
  }

  // ------------------------------------------------------------------ recently viewed

  recentFiles() {
    try { return JSON.parse(localStorage.getItem(`recent:${this.root}`) ?? "[]"); } catch { return []; }
  }

  rememberViewed(path) {
    if (!this.root || !path) return;
    const next = [path, ...this.recentFiles().filter((p) => p !== path)].slice(0, RECENT_VIEWED);
    try { localStorage.setItem(`recent:${this.root}`, JSON.stringify(next)); } catch {}
  }

  // ------------------------------------------------------------------ preview

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    this.fileHunks = []; this.fileLines = 0; this.lineStarts = null; this.imageRel = null;
    this.diff = null; this.diffMode = false; this.editing = false; this.dirty = false; this.original = null;
    if (!path || !cx) return;
    this.rememberViewed(path);
    const context = this.context, root = this.root, on = this.on;
    if (IMAGE.test(path)) { this.showImage(path, cx); return; }
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        this.original = text;
        this.truncated = text.length > 400000;
        const value = this.truncated ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        // Line start offsets (UTF-16, as the editor's selection uses) for jumping to a change.
        const starts = [0];
        for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) starts.push(i + 1);
        this.lineStarts = starts; this.fileLines = starts.length;
        // Changes against HEAD for the ruler and the diff view; an untracked file is all added.
        const mark = this.marks[`${root}/${path}`];
        if (mark === "U") {
          this.fileHunks = [{ kind: "added", start: 1, count: starts.length }];
          this.diff = value.split("\n").map((l, i) => ({ kind: "add", text: l, new: i + 1 }));
        } else if (mark) {
          const d = await git(root, on, ["diff", "--no-color", "--no-ext-diff", "-U3", "HEAD", "--", path]);
          if (this.file !== path || !this.current(context)) return;
          if (d?.code === 0) { this.fileHunks = parseHunks(d.stdout); this.diff = diffLines(d.stdout); }
        }
        this.makeEditor(value, true);
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  makeEditor(value, readonly) {
    const t = theme(), e = ext(this.file ?? "") || "txt";
    this.code?.release();
    this.code = EditorState.new({ language: LANG[e] ?? e, readonly, value,
      font_family: settings().font_family, font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
    if (!readonly) this.code.on("change", (_e, cx) => { if (!this.dirty) { this.dirty = true; cx.notify(); } });
  }

  // image() only loads files under the app's folder: copy the image into data/vnh-files/preview
  // (a fresh name per view, so an edited image reloads; the 20 newest are kept).
  showImage(path, cx) {
    if (this.on) { this.fileError = "Image preview works for this computer's files only"; cx.notify(); return; }
    const context = this.context, dir = `${appHome()}/data/vnh-files/preview`;
    const name = `${Date.now()}-${base(path).replace(/[^A-Za-z0-9._-]/g, "_")}`;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'mkdir -p "$1" && cp -f "$2" "$1/$3" && cd "$1" && ls -t | tail -n +21 | while IFS= read -r f; do rm -f -- "$f"; done', "img", dir, `${this.root}/${path}`, name]).catch(() => null);
      if (this.file !== path || !this.current(context)) return;
      if (r?.code === 0) this.imageRel = `data/vnh-files/preview/${name}`;
      else this.fileError = "Cannot show this image";
      cx.notify();
    });
  }

  startEdit(cx) {
    if (!this.code || this.on || this.truncated || this.original == null) return;
    this.editing = true; this.diffMode = false; this.dirty = false;
    this.makeEditor(this.original, false);
    this.code.focus();
    cx.notify();
  }

  cancelEdit(cx) {
    this.editing = false; this.dirty = false;
    this.makeEditor(this.original, true);
    this.kb.focus();
    cx.notify();
  }

  // Saves only if the file is still what was loaded (writeTextFile's check); else says so.
  save(cx) {
    if (!this.editing || !this.code) return;
    const path = this.file, text = this.code.value(), expected = this.original;
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(`${this.root}/${path}`, text, expected);
        if (this.file !== path) return;
        this.original = text; this.dirty = false;
        notify({ title: "Saved", body: path, level: "success", timeout: 2000 });
        this.refresh(cx);
      } catch (e) {
        notify({ title: "Not saved", body: `${path} changed on disk since it was opened. Cancel and reopen it to see the new version.`, level: "error" });
      } finally { cx.notify(); }
    });
  }

  openMarkdown() {
    if (!this.file || !this.root) return;
    openMarkdownTab(`${this.root}/${this.file}`, this.on);
  }

  openMarkdownPath(path) {
    openMarkdownTab(`${this.root}/${path}`, this.on);
  }

  // ------------------------------------------------------------------ rows

  // The rows shown now, as data: { key, kind: "entry" | "flat" | "section" | "note", path, dir, depth, ... }.
  items() {
    if (this.search.open) {
      const q = this.search.query.trim();
      if (!q) {
        const recent = this.recentFiles();
        return [{ key: "s:viewed", kind: "section", label: recent.length ? "Recently viewed" : "No recently viewed files", static: true },
          ...recent.map((p) => ({ key: `f:${p}`, kind: "flat", path: p, dir: false }))];
      }
      if (!this.search.files) return [{ key: "n:loading", kind: "note", label: "Listing files…" }];
      const hits = searchFiles(this.search.files, q);
      return hits.length ? hits.map((p) => ({ key: `f:${p}`, kind: "flat", path: p, dir: false }))
        : [{ key: "n:none", kind: "note", label: "No matching files" }];
    }
    if (this.changedOnly) {
      const pre = this.root + "/";
      const files = Object.keys(this.marks).filter((p) => p.startsWith(pre)).map((p) => p.slice(pre.length)).sort();
      return files.length ? files.map((p) => ({ key: `f:${p}`, kind: "flat", path: p, dir: false, gone: this.marks[pre + p] === "D" }))
        : [{ key: "n:clean", kind: "note", label: this.inRepo ? "No changes" : "Not a git repository" }];
    }
    const out = [];
    if (this.recentChanged.length) {
      out.push({ key: "s:recent", kind: "section", label: `Recent changes (${this.recentChanged.length})`, open: this.recentOpen });
      if (this.recentOpen) for (const r of this.recentChanged) out.push({ key: `r:${r.path}`, kind: "flat", path: r.path, dir: false, mtime: r.mtime });
    }
    this.flatten("", 0, out);
    return out;
  }

  flatten(prefix, depth, out) {
    if (out.length >= TOTAL || depth > 40) return;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (this.ignored.has(path) && !this.showIgnored) continue;
      out.push({ key: `e:${path}`, kind: "entry", path, dir: entry.dir, depth, entry });
      if (entry.dir && this.folders.has(path)) this.flatten(path, depth + 1, out);
    }
  }

  cursorIndex(items = this.items()) {
    return this.cursor ? items.findIndex((it) => it.key === this.cursor) : -1;
  }

  // Click or Enter on a row.
  activate(it, cx) {
    if (!it) return;
    this.cursor = it.key;
    if (it.kind === "section") { if (!it.static) this.setFlag("recentOpen", !this.recentOpen, cx); return; }
    if (it.kind !== "entry" && it.kind !== "flat") return;
    if (it.dir) this.toggle(it.path, cx);
    else if (!it.gone) {
      if (this.search.open) { this.search.open = false; this.kb.focus(); }
      this.show(it.path, cx);
    }
    cx.notify();
  }

  menu(it, cx) {
    if (!it || (it.kind !== "entry" && it.kind !== "flat") || !this.root) return;
    this.cursor = it.key;
    const space = spaces().find((s) => s.active)?.id ?? null;
    openOverlay({ mod: "vnh-files-menu", kind: "popup", width: 260, height: 420,
      props: { root: this.root, path: it.path, dir: Boolean(it.dir), on: this.on ?? null, space, gone: Boolean(it.gone) } });
    cx.notify();
  }

  // Rendered inside the virtual list: no handlers here (they throw); see on_item_click.
  row(it, i, t) {
    const sel = it.key === this.cursor;
    const base_ = h_flex().id(`row-${it.key}`).w_full().h(ROW).flex_none().pr(8).gap(7).items_center().rounded(7).cursor_pointer()
      .when(sel, (el) => el.bg(alpha(t.accent, 0.18))).hover((s) => s.bg(t.hover));
    if (it.kind === "note") return base_.id(`row-${it.key}`).pl(12).text_size(12).text_color(t.dim).child(it.label);
    if (it.kind === "section") {
      return base_.pl(8).text_size(11).text_color(t.dim).font_semibold()
        .when(!it.static, (el) => el.child(svg(`mods/vnh-files/chevron-${it.open ? "down" : "right"}.svg`).size(12).flex_none()))
        .child(svg(`mods/vnh-files/${it.key === "s:recent" ? "clock" : "search"}.svg`).size(12).flex_none())
        .child(div().child(it.label.toUpperCase()));
    }
    const abs = `${this.root}/${it.path}`, mark = this.marks[abs];
    const ignored = this.ignored.has(it.path);
    const folderMark = it.dir ? (mark ?? this.folderMarks?.[abs]) : null;
    const color = ignored ? t.dim : markColor(t, it.dir ? folderMark : mark);
    const name = it.kind === "flat" ? base(it.path) : it.entry.name;
    const meta = it.kind === "flat"
      ? (it.mtime ? ago(it.mtime) : "")
      : !this.showSizes ? "" : it.dir ? (it.entry.counts ? fmtCounts(it.entry.counts.dirs, it.entry.counts.files) : "") : fmtSize(it.entry.size);
    return base_.pl(it.kind === "entry" ? 8 + it.depth * 18 : 8)
      // Drag into a terminal: locally `@<path>` relative to this panel's folder (Claude Code reads
      // it as a file mention; a folder ends in `/`); on another machine the absolute path.
      .drag_paths([this.on ? abs : `@${it.path}${it.dir ? "/" : ""}`], { on: this.on ?? null })
      .child(it.kind === "entry" && it.dir ? svg(`mods/vnh-files/chevron-${this.folders.has(it.path) ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(svg(`mods/vnh-files/${it.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(it.dir && color ? color : t.muted))
      .child(div().flex_none().max_w("70%").truncate().when(Boolean(color), (el) => el.text_color(color)).when(Boolean(it.gone), (el) => el.line_through()).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(it.kind === "flat" ? parent(it.path) : ""))
      .when(Boolean(meta), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(meta)))
      .when(!it.dir && Boolean(mark), (el) => el.child(div().flex_none().w(12).text_size(11).text_color(markColor(t, mark)).child(mark)))
      .when(it.dir && Boolean(folderMark) && !ignored, (el) => el.child(div().flex_none().w(12).text_size(11).text_color(markColor(t, folderMark)).child("•")));
  }

  // ------------------------------------------------------------------ keyboard

  moveCursor(items, i, cx) {
    if (!items.length) return;
    const n = Math.max(0, Math.min(items.length - 1, i));
    this.cursor = items[n].key;
    if (n < this.range.start + 1 || n >= this.range.end - 1) this.listScroll.scroll_to_item(n, "center");
    cx.notify();
  }

  onKey(e, cx) {
    const m = e.modifiers ?? {}, k = e.key;
    // ⌘S saves while editing; ⌘F opens search.
    if (m.platform && k === "s") { if (this.editing) { cx.stop_propagation(); this.save(cx); } return; }
    if (m.platform && k === "f" && !this.file) { cx.stop_propagation(); this.openSearch(cx); return; }
    if (m.control || m.alt || m.platform) return;
    if (this.file) {
      if (this.editing) { if (k === "escape" && !this.dirty) { cx.stop_propagation(); this.cancelEdit(cx); } return; }
      if (k === "space" && !m.shift && MARKDOWN.test(this.file)) { cx.stop_propagation(); this.openMarkdown(); }
      else if (k === "escape") { cx.stop_propagation(); const p = this.file; this.show(null); this.cursor = this.cursor ?? `e:${p}`; this.kb.focus(); cx.notify(); }
      return;
    }
    const items = this.items(), i = this.cursorIndex(items), it = items[i];
    if (k === "escape") {
      cx.stop_propagation();
      if (this.search.open) this.closeSearch(cx);
      else if (this.changedOnly) this.setFlag("changedOnly", false, cx);
      return;
    }
    if (k === "down") { cx.stop_propagation(); this.moveCursor(items, i + 1, cx); return; }
    if (k === "up") { cx.stop_propagation(); this.moveCursor(items, i < 0 ? 0 : i - 1, cx); return; }
    if (this.search.open) return; // the box takes the other keys (Enter submits it)
    if (e.key_char === "/") { cx.stop_propagation(); this.openSearch(cx); return; }
    if (!it) return;
    if (k === "enter") { cx.stop_propagation(); this.activate(it, cx); return; }
    if (k === "space") {
      cx.stop_propagation();
      if (!it.dir && MARKDOWN.test(it.path)) this.openMarkdownPath(it.path); else this.activate(it, cx);
      return;
    }
    if (k === "right" && it.kind === "entry" && it.dir) {
      cx.stop_propagation();
      if (!this.folders.has(it.path)) this.toggle(it.path, cx); else this.moveCursor(items, i + 1, cx);
      return;
    }
    if (k === "left") {
      cx.stop_propagation();
      if (it.kind === "entry" && it.dir && this.folders.has(it.path)) this.toggle(it.path, cx);
      else if (it.kind === "entry" && parent(it.path)) { this.cursor = `e:${parent(it.path)}`; this.moveCursor(items, this.cursorIndex(items), cx); }
    }
  }

  // ------------------------------------------------------------------ render

  // A 24 px icon button in the header; `on` highlights a toggle that is active.
  tool(t, id, icon, label, on, action) {
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(label).on_click((_e, cx) => action(cx)).child(svg(`mods/vnh-files/${icon}.svg`).size(14));
  }

  // The preview's path as a breadcrumb: a folder opens it in the tree.
  crumbs(t) {
    const parts = this.file.split("/"), name = parts.pop();
    const dirs = h_flex().flex_shrink(1).min_w(0).gap(2).items_center().justify_end().overflow_hidden();
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      dirs.child(div().id(`crumb-${path}`).flex_shrink(1).min_w(0).max_w(140).truncate().cursor_pointer().rounded(4).px(2)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`Show ${path} in the tree`)
        .on_click((_e, cx) => this.reveal(path, cx)).child(part))
        .child(div().flex_none().child("/"));
    });
    // The file name always shows; the folders before it shrink first.
    return h_flex().flex_1().min_w(0).gap(2).items_center().justify_end().overflow_hidden().text_size(12).text_color(t.dim)
      .child(dirs)
      .child(div().flex_none().max_w("70%").truncate().text_color(t.foreground).child(name));
  }

  header(t) {
    const md = Boolean(this.file) && MARKDOWN.test(this.file);
    const canDiff = Boolean(this.file) && Boolean(this.diff?.length) && !this.editing;
    const canEdit = Boolean(this.code) && !this.on && !this.truncated && !this.diffMode;
    return h_flex().id("files-header").on_mouse_down("left", () => this.kb.focus()).h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .when(Boolean(this.file), (el) => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted)
        .on_click((_e, cx) => { if (this.editing && this.dirty) return; this.show(null); this.kb.focus(); cx.notify(); }).child("←")))
      .child(div().flex_none().max_w(200).truncate().font_semibold().child(this.root?.split(/[\\/]/).pop() || "Files"))
      .when(Boolean(this.file), (el) => el.child(this.crumbs(t)))
      .when(!this.file, (el) => el.child(div().flex_1()))
      .when(this.editing, (el) => el
        .child(div().flex_none().text_size(11).text_color(this.dirty ? t.ansi3 : t.dim).child(this.dirty ? "● unsaved" : "editing"))
        .child(this.tool(t, "files-save", "check", "Save (⌘S)", this.dirty, (cx) => this.save(cx)))
        .child(this.tool(t, "files-cancel", "x", this.dirty ? "Discard changes" : "Stop editing (Esc)", false, (cx) => this.cancelEdit(cx))))
      .when(!this.editing && canDiff, (el) => el.child(this.tool(t, "files-diff", "git-compare", this.diffMode ? "Show the file" : "Show changes against HEAD", this.diffMode,
        (cx) => { this.diffMode = !this.diffMode; cx.notify(); })))
      .when(!this.editing && canEdit, (el) => el.child(this.tool(t, "files-edit", "square-pen", "Edit", false, (cx) => this.startEdit(cx))))
      .when(md && !this.editing, (el) => el.child(this.tool(t, "files-md-open", "eye", "Open rendered Markdown in a new tab (Space)", false, () => this.openMarkdown())))
      .when(!this.file, (el) => el.child(h_flex().flex_none().gap(2).items_center()
        .when(!this.panelHover && !this.sortOpen && !this.search.open && !this.changedOnly, (el) => el.invisible())
        .child(this.tool(t, "files-search", "search", "Search files by name (/ or ⌘F)", this.search.open, (cx) => (this.search.open ? this.closeSearch(cx) : this.openSearch(cx))))
        .child(this.tool(t, "files-changed", "git-compare", this.changedOnly ? "Show all files" : "Show changed files only", this.changedOnly, (cx) => this.setFlag("changedOnly", !this.changedOnly, cx)))
        .child(this.tool(t, "files-sort", "sort", "Sort", this.sortOpen, (cx) => {
          // The click that closed the menu (outside it) is this same press: don't reopen.
          if (!this.sortOpen && Date.now() - (this.sortClosedAt ?? 0) < 250) return;
          this.sortOpen = !this.sortOpen; cx.notify();
        }))
        .child(this.tool(t, "files-ignored", this.showIgnored ? "eye" : "eye-off", this.showIgnored ? "Hide ignored files" : "Show ignored files", !this.showIgnored, (cx) => this.setFlag("showIgnored", !this.showIgnored, cx)))
        .child(this.tool(t, "files-sizes", "ruler", this.showSizes ? "Hide sizes" : "Show sizes", this.showSizes, (cx) => this.setFlag("showSizes", !this.showSizes, cx)))
        .child(this.tool(t, "files-expand", "expand-all", this.expanding ? "Expanding…" : "Expand all", this.expanding, (cx) => this.expandAll(cx)))
        .child(this.tool(t, "files-collapse", "collapse-all", "Collapse all", false, (cx) => this.collapseAll(cx)))));
  }

  list(t) {
    const items = this.items();
    const note = Boolean(this.error) || (!this.search.open && !this.changedOnly && !this.entries.get("")?.length)
      ? (this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder")) : null;
    return v_flex().flex_1().min_h(0)
      .when(this.search.open, (el) => el.child(h_flex().h(34).flex_none().mx(6).mt(6).px(8).gap(6).items_center().rounded(7).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/vnh-files/search.svg").size(13).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.search.loading ? "…" : this.search.files ? `${this.search.files.length.toLocaleString()} files` : ""))))
      .when(this.changedOnly && !this.search.open, (el) => el.child(h_flex().h(26).flex_none().px(14).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(svg("mods/vnh-files/git-compare.svg").size(12)).child(div().child("CHANGED FILES")).child(div().flex_1())
        .child(div().id("files-changed-off").cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.setFlag("changedOnly", false, cx)).child("show all"))))
      .child(div().id("files-tree").relative().flex_1().min_h(0).p(6).on_mouse_down("left", () => this.kb.focus())
        .when(Boolean(note), (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child(note)))
        .when(!note, (el) => el
          .child(v_virtual_list("files-rows", items.length, ROW, (i) => items[i].key, (range) => {
            this.range = range;
            return items.slice(range.start, range.end).map((it, j) => this.row(it, range.start + j, t));
          })
          // Handlers can't live in the row renderer (rows are rebuilt every frame): one for the list.
          .on_item_click((k, cx) => this.activate(items.find((it) => it.key === k), cx))
          .on_item_secondary_click((k, _e, cx) => this.menu(items.find((it) => it.key === k), cx))
          .track_scroll(this.listScroll).size_full())
          .child(Scrollbar.vertical("files-rows").absolute().inset_0())))
      .when(this.limited && !this.search.open && !this.changedOnly, (el) => el.child(div().px(14).py(6).flex_none().text_size(11).text_color(t.dim)
        .child(`File list limited to ${PER_FOLDER.toLocaleString()} entries per folder and ${TOTAL.toLocaleString()} total`)));
  }

  diffView(t) {
    const lines = this.diff ?? [];
    const bg = { add: alpha(t.ansi2, 0.16), del: alpha(t.ansi1, 0.16), hunk: alpha(t.ansi4, 0.12) };
    const fg = { add: t.ansi2, del: t.ansi1, hunk: t.ansi4 };
    const num = (n) => div().w(38).flex_none().text_right().pr(6).text_color(t.dim).child(n === undefined ? "" : String(n));
    return div().relative().flex_1().min_h(0).font_family(settings().font_family).text_size(12)
      .child(v_virtual_list("files-diff", lines.length, DIFF_ROW, (i) => String(i), (range) =>
        lines.slice(range.start, range.end).map((l, j) => h_flex().id(`diff-${range.start + j}`).w_full().h(DIFF_ROW).flex_none().items_center().when(Boolean(bg[l.kind]), (el) => el.bg(bg[l.kind]))
          .when(l.kind !== "hunk", (el) => el.child(num(l.old)).child(num(l.new)))
          .child(div().w(14).flex_none().text_color(fg[l.kind] ?? t.dim).child(l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "hunk" ? "" : " "))
          .child(div().flex_1().min_w(0).truncate().text_color(l.kind === "hunk" ? fg.hunk : t.foreground).child(l.text || " "))))
        .track_scroll(this.diffScroll).size_full())
      .child(Scrollbar.vertical("files-diff").absolute().inset_0());
  }

  preview(t) {
    if (this.imageRel) {
      return div().id("files-image").flex_1().min_h(0).p(12).flex().items_center().justify_center().overflow_hidden()
        .child(image(this.imageRel).max_w_full().max_h_full());
    }
    if (!this.code) return div().p(12).text_color(t.dim).child(this.fileError || "Loading file…");
    if (this.diffMode) return this.diffView(t);
    return h_flex().flex_1().min_h(0).child(Editor.new(this.code).flex_1().min_w(0).min_h(0))
      .when(this.fileHunks.length > 0 && !this.editing, (el) => el.child(this.ruler(t)));
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    // The header's buttons show only while the pointer is over the panel (space kept, nothing shifts).
    return v_flex().id("files").track_focus(this.kb).relative().size_full().min_h(0).rounded(10).overflow_hidden()
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_hover((hovered, cx) => { if (this.panelHover !== hovered) { this.panelHover = hovered; cx.notify(); } })
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(this.header(t))
      .when(!this.file, (el) => el.child(this.list(t)))
      .when(Boolean(this.file), (el) => el.child(this.preview(t)))
      .when(this.sortOpen && !this.file, (el) => el.child(this.sortMenu(t)));
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
          .when(h.count > 0, (el) => el.h(pct(h.count / total))).when(h.count === 0, (el) => el.h(3))
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
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.setSort(by, cx))
        .child(by === this.sortBy ? svg("mods/vnh-files/check.svg").size(14).flex_none() : div().w(14).flex_none())
        .child(div().child(label))));
  }
}

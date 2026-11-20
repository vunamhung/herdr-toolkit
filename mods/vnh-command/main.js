// Run any command in a new tab (cmd-enter). The tab opens in the active space at the project
// folder (the focused terminal's repo root, else its folder) and runs the command through the
// login shell (`$SHELL -ic`), so aliases, functions, `&&` and pipes work.
// Empty input lists the history (newest first), then the project's package.json scripts (the run
// configurations that used to sit in the sidebar); typing ranks scripts by name and filters the
// history. ↑/↓ choose, Enter runs, ctrl-d forgets the chosen history entry, Esc closes.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, run, props, shared, setShared, closeOverlay, spaces, panes, focused, exec, readTextFile } from "herdr";

const HISTORY = "vnh.cmd.history"; // shared, persisted: [{ cmd, root, at }] newest first
const MAX_HISTORY = 200;

function ago(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const base = (p) => (p || "").replace(/\/+$/, "").split("/").pop() || p;
const LOCK_PM = { "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "bun.lockb": "bun", "bun.lock": "bun", "package-lock.json": "npm" };

// Scripts whose name starts with the text, then has every word ("gate dev"), then its letters in
// order ("dgw"), then whose command alone matches; A–Z within a rank.
function rankScripts(scripts, q0) {
  const q = q0.trim().toLowerCase();
  const sorted = [...scripts].sort((a, b) => a.name.localeCompare(b.name));
  if (!q) return sorted;
  const words = q.split(/\s+/), letters = q.replace(/\s+/g, "");
  const inOrder = (text) => { let i = 0; for (const ch of text) if (ch === letters[i]) i++; return i === letters.length; };
  const ranked = [];
  for (const s of sorted) {
    const name = s.name.toLowerCase(), cmd = s.cmd.toLowerCase();
    const rank = name.startsWith(q) ? 0 : words.every((w) => name.includes(w)) ? 1 : inOrder(name) ? 2 : words.every((w) => cmd.includes(w)) ? 3 : -1;
    if (rank >= 0) ranked.push({ s, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((x) => x.s);
}

// The folder the focused work happens in. A mod pane (the Markdown viewer, …) has none, and a
// space's starting folder can be another project: fall back to the last terminal folder focused
// in this space (shared "vnh.lastCwd", kept by vnh-files), then the space's first terminal, then
// its starting folder.
function workFolder(space, f) {
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

export default class CommandRunner extends View {
  init(_props, cx) {
    this.filter = "";
    this.at = 0;
    this.root = null; this.on = null; this.space = null; this.shell = "sh";
    this.scripts = []; this.pm = "npm";
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Type a command to run in a new tab…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submit());
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());

    // Where to run: the active space's focused terminal folder, lifted to its repo root.
    const space = spaces().find((s) => s.active), f = focused();
    const cwd = workFolder(space, f);
    this.space = space?.id ?? null; this.on = space?.machine ?? null; this.root = cwd;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'git -C "$1" rev-parse --show-toplevel 2>/dev/null || echo "$1"; echo "${SHELL:-sh}"', "where", cwd || "."], { on: this.on, timeout: 5000 }).catch(() => null);
      const [root, shell] = (r?.stdout ?? "").split("\n").map((x) => x.trim());
      if (root) this.root = root;
      if (shell) this.shell = shell;
      cx.notify();
      // The project's package.json scripts (at the repo root only), with its package manager:
      // "packageManager", else the lock file, else npm.
      if (!this.root) return;
      const text = await readTextFile(`${this.root}/package.json`, { on: this.on }).catch(() => null);
      let pkg = null;
      try { pkg = text ? JSON.parse(text) : null; } catch { pkg = null; }
      const scripts = Object.entries(pkg?.scripts ?? {}).filter(([, v]) => typeof v === "string").map(([name, cmd]) => ({ name, cmd }));
      if (!scripts.length) return;
      const declared = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
      let pm = ["pnpm", "yarn", "bun", "npm"].includes(declared) ? declared : null;
      if (!pm) {
        const l = await exec("sh", ["-c", 'for f in pnpm-lock.yaml yarn.lock bun.lockb bun.lock package-lock.json; do [ -e "$1/$f" ] && { echo "$f"; break; }; done; true', "lock", this.root], { on: this.on, timeout: 5000 }).catch(() => null);
        pm = LOCK_PM[(l?.stdout ?? "").trim()] ?? "npm";
      }
      this.pm = pm; this.scripts = scripts;
      cx.notify();
    });
  }

  history() {
    const h = shared(HISTORY);
    return Array.isArray(h) ? h : [];
  }

  // Rows: the typed command first (when it isn't already an entry), then, while typing, the matching
  // scripts and history; with nothing typed, the history and then every script.
  rows() {
    const f = this.filter.trim(), lower = f.toLowerCase();
    const scripts = rankScripts(this.scripts, f).map((s) => ({ cmd: `${this.pm} run ${s.name}`, script: s }));
    const scriptCmds = new Set(scripts.map((s) => s.cmd));
    const hits = this.history().filter((e) => !lower || e.cmd.toLowerCase().includes(lower));
    const typed = f && !hits.some((e) => e.cmd === f) && !scriptCmds.has(f) ? [{ cmd: f, typed: true }] : [];
    return f ? [...typed, ...scripts, ...hits.filter((e) => !scriptCmds.has(e.cmd))] : [...hits, ...scripts];
  }

  close() { closeOverlay(props().overlay); }

  remember(cmd) {
    const next = [{ cmd, root: this.root, at: Date.now() }, ...this.history().filter((e) => e.cmd !== cmd)].slice(0, MAX_HISTORY);
    setShared(HISTORY, next);
  }

  forget(cmd) {
    setShared(HISTORY, this.history().filter((e) => e.cmd !== cmd));
  }

  start(cmd) {
    cmd = (cmd || "").trim();
    if (!cmd || !this.space) return;
    this.remember(cmd);
    this.close();
    run("tab.new", { space: this.space, folder: this.root ?? undefined, name: cmd.length > 40 ? cmd.slice(0, 39) + "…" : cmd,
      argv: [this.shell, "-ic", cmd] });
  }

  submit() {
    const rows = this.rows();
    this.start((rows[this.at] ?? rows[0])?.cmd ?? this.filter);
  }

  render() {
    const t = theme(), rows = this.rows();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    return v_flex().id("vnh-command").track_focus(this.handle).w_full().p(14).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "d" && e.modifiers.control) { const r = rows[this.at]; if (r && !r.typed && !r.script) this.forget(r.cmd); }
        else if (!rows.length) return;
        else if (k === "down") this.at = (this.at + 1) % rows.length;
        else if (k === "up") this.at = (this.at + rows.length - 1) % rows.length;
        else return;
        this.scroll.scroll_to_item(this.at);
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(40).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/vnh-command/terminal.svg").size(15).flex_none().text_color(t.muted))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`in ${base(this.root) || "…"}`)))
      .child(h_flex().px(4).text_size(11).text_color(t.dim)
        .child(div().flex_1().child(this.filter.trim() ? "Enter runs it in a new tab" : this.history().length ? (this.scripts.length ? "History, then package.json scripts" : "History") : this.scripts.length ? "package.json scripts" : "No history yet"))
        .child(div().child("↑↓ choose · Enter run · ⌃D forget · Esc")))
      // A popup is as tall as its content: a definite height lets a long list scroll.
      .child(v_flex().id("vnh-command-rows").h(Math.min(360, Math.max(32, rows.length * 31))).flex_none().gap(1).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(rows.map((r, i) => {
          const on = i === this.at;
          return h_flex().id(`cmd-row-${i}`).h(30).flex_none().px(10).gap(8).items_center().rounded(7).cursor_pointer()
            .when(on, (el) => el.bg(t.selection ?? t.selected)).hover((s) => s.bg(t.hover))
            .on_click(() => this.start(r.cmd))
            .child(svg(`mods/vnh-command/${r.typed ? "terminal" : r.script ? "package" : "clock"}.svg`).size(13).flex_none().text_color(r.typed || r.script ? t.ansi2 : t.dim))
            .child(div().when(!r.script, (el) => el.flex_1()).flex_none().min_w(0).truncate().text_color(t.foreground).child(r.typed ? `Run: ${r.cmd}` : r.cmd))
            .when(Boolean(r.script), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(r.script.cmd)))
            .when(!r.typed && !r.script, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`${base(r.root)} · ${ago(r.at)}`)));
        })));
  }
}

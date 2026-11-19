// Run any command in a new tab (cmd-enter). The tab opens in the active space at the project
// folder (the focused terminal's repo root, else its folder) and runs the command through the
// login shell (`$SHELL -ic`), so aliases, functions, `&&` and pipes work.
// Empty input lists the history (newest first); typing filters it. ↑/↓ choose, Enter runs,
// ctrl-d forgets the chosen history entry, Esc closes.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, run, props, shared, setShared, closeOverlay, spaces, panes, focused, exec } from "herdr";

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
    });
  }

  history() {
    const h = shared(HISTORY);
    return Array.isArray(h) ? h : [];
  }

  // Rows: the typed command first (when it isn't already an exact history entry), then matches.
  rows() {
    const f = this.filter.trim(), lower = f.toLowerCase();
    const hits = this.history().filter((e) => !lower || e.cmd.toLowerCase().includes(lower));
    const typed = f && !hits.some((e) => e.cmd === f) ? [{ cmd: f, typed: true }] : [];
    return [...typed, ...hits];
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
        if (k === "d" && e.modifiers.control) { const r = rows[this.at]; if (r && !r.typed) this.forget(r.cmd); }
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
        .child(div().flex_1().child(this.filter.trim() ? "Enter runs it in a new tab" : this.history().length ? "History" : "No history yet"))
        .child(div().child("↑↓ choose · Enter run · ⌃D forget · Esc")))
      .child(v_flex().id("vnh-command-rows").max_h(360).gap(1).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(rows.map((r, i) => {
          const on = i === this.at;
          return h_flex().id(`cmd-row-${i}`).h(30).flex_none().px(10).gap(8).items_center().rounded(7).cursor_pointer()
            .when(on, (el) => el.bg(t.selection ?? t.selected)).hover((s) => s.bg(t.hover))
            .on_click(() => this.start(r.cmd))
            .child(svg(`mods/vnh-command/${r.typed ? "terminal" : "clock"}.svg`).size(13).flex_none().text_color(r.typed ? t.ansi2 : t.dim))
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.typed ? `Run: ${r.cmd}` : r.cmd))
            .when(!r.typed, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`${base(r.root)} · ${ago(r.at)}`)));
        })));
  }
}

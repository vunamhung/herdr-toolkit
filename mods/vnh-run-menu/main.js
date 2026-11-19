// Run configurations popup, opened by vnh-chrome's run bar (JetBrains style): the project's
// package.json scripts. Type to filter, ↑/↓ to move, Enter or a click selects the script for the
// run bar, ▶ on a row runs it now, Esc closes.
//
// props: { project: { root, on, space, pm, scripts: [{ name, cmd }] }, selected }
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, run, props, shared, setShared, closeOverlay } from "herdr";

function choose(project, name) {
  setShared("vnh.run.selected", { ...(shared("vnh.run.selected") ?? {}), [project.root]: name });
}

function runScript(project, name) {
  run("tab.new", { space: project.space, folder: project.root, name: `${project.pm} run ${name}`, argv: [project.pm, "run", name] });
}

export default class RunMenu extends View {
  init(_props, cx) {
    this.filter = "";
    this.hover = null;
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search configurations" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.pick(this.rows()[this.at]));
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    this.at = Math.max(0, this.rows().findIndex((s) => s.name === props()?.selected));
    this.handle = cx.focus_handle();
  }

  rows() {
    // Alphabetical, as JetBrains lists run configurations.
    const scripts = [...(props()?.project?.scripts ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const f = this.filter.trim().toLowerCase();
    return f ? scripts.filter((s) => s.name.toLowerCase().includes(f) || s.cmd.toLowerCase().includes(f)) : scripts;
  }

  close() { closeOverlay(props().overlay); }

  pick(row) {
    if (!row) return;
    choose(props().project, row.name);
    this.close();
  }

  start(row) {
    if (!row) return;
    const p = props().project;
    choose(p, row.name);
    this.close();
    runScript(p, row.name);
  }

  render() {
    const t = theme(), p = props()?.project, rows = this.rows();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const selected = props()?.selected;
    // A popup is as tall as its content: the list gets a max height and scrolls past it.
    return v_flex().id("run-menu").track_focus(this.handle).w_full().bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (!rows.length) return;
        if (k === "down") this.at = (this.at + 1) % rows.length;
        else if (k === "up") this.at = (this.at + rows.length - 1) % rows.length;
        else return;
        this.scroll.scroll_to_item(this.at);
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/vnh-run-menu/search.svg").size(14).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(v_flex().id("run-menu-rows").max_h(380).p(4).gap(1).overflow_y_scrollbar().track_scroll(this.scroll)
        .when(rows.length === 0, (el) => el.child(div().p(10).text_size(12).text_color(t.dim).child(p ? "No matching scripts" : "No package.json scripts")))
        .children(rows.map((r, i) => {
          const on = i === this.at, current = r.name === selected;
          return h_flex().id(`run-row-${r.name}`).h(30).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
            .when(on, (el) => el.bg(t.selection ?? t.selected)).hover((s) => s.bg(t.hover))
            .on_hover((h, cx) => { const next = h ? r.name : this.hover === r.name ? null : this.hover; if (next !== this.hover) { this.hover = next; cx.notify(); } })
            .on_click(() => this.pick(r))
            .child(svg("mods/vnh-run-menu/package.svg").size(14).flex_none().text_color(t.ansi2))
            .child(div().flex_none().max_w(220).truncate().text_color(t.foreground).when(current, (el) => el.font_semibold()).child(`${p.pm} run ${r.name}`))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(r.cmd))
            .when(on || this.hover === r.name, (el) => el.child(div().id(`run-go-${r.name}`).size(22).flex_none().flex().items_center().justify_center().rounded(5)
              .hover((s) => s.bg(t.hover)).tooltip(`Run ${p.pm} run ${r.name}`)
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); this.start(r); })
              .child(svg("mods/vnh-run-menu/play.svg").size(13).text_color(t.ansi2))));
        })));
  }
}

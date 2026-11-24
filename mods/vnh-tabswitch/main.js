// The tab switcher's popup: tabs of the space you are in (the repo), or of every space grouped under their space's name; the one
// showing marked "now". It only draws what vnh-tabs keeps in shared "vnh.tabswitch".
//   mode "space": momentary. The two fingers that opened it scroll the highlight and, where they lift, that tab is selected.
//   mode "all": a menu that stays. Scroll it, click a tab (its space is selected too) to go there; Esc, or a click outside, closes it.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { theme, shared, run, spaces, props, closeOverlay } from "herdr";

const ROWS = 16;                         // "space" mode: lines shown (group headers count), scrolled around the highlight
function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
const DOT = { working: "#e0a63a", blocked: "#d9649a", done: "#3fae6a", idle: null };

export default class TabSwitch extends View {
  init(_props, cx) {
    this.seen = "";
    this.scroll = ScrollHandle.new();
    cx.timer.every(60, (cx) => {
      const st = shared("vnh.tabswitch"), sig = st ? `${st.sel}|${st.items?.length}|${st.mode}` : "";
      if (sig !== this.seen) { this.seen = sig; cx.notify(); }
    });
    // "all": the list opens at the tab you are on.
    cx.timer.after(120, (cx) => {
      const st = shared("vnh.tabswitch");
      if (st?.mode !== "all") return;
      const at = this.lines(st).findIndex((l) => l.i === st.sel);
      if (at > 0) { try { this.scroll.scroll_to_item(at); } catch {} cx.notify(); }
    });
  }

  // The lines: a header before each group (in "space" mode, the one space's name), then its tabs.
  lines(st) {
    const lines = [];
    for (const g of st.groups ?? []) {
      lines.push({ head: g.name || "Tabs" });
      for (let i = g.first; i < g.first + g.count; i++) lines.push({ i });
    }
    return lines;
  }

  pick(it) {
    if (spaces().find((s) => s.active)?.id !== it.space) run("space.select", { id: it.space });
    run("tab.select", { id: it.tab });
    try { closeOverlay(props().overlay); } catch {}
  }

  render() {
    const t = theme(), st = shared("vnh.tabswitch") ?? { items: [], groups: [], sel: 0, mode: "space" };
    const menu = st.mode === "all", lines = this.lines(st), n = lines.length;
    const at = Math.max(0, lines.findIndex((l) => l.i === st.sel));
    const from = menu ? 0 : Math.max(0, Math.min(at - Math.floor(ROWS / 2), n - ROWS)), shown = menu ? lines : lines.slice(from, from + ROWS);
    const row = (l, k) => {
      if (l.head !== undefined) return div().id(`sw-h-${from + k}`).flex_none().px(12).pt(k === 0 ? 2 : 8).pb(4).truncate().text_size(11).text_color(t.dim).child(l.head);
      const c = st.items[l.i], on = l.i === st.sel, dot = DOT[c.status] ?? null;
      return h_flex().id(`sw-${c.tab}`).h(32).flex_none().px(12).gap(9).items_center().rounded(7).text_size(13)
        .bg(on && !menu ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .when(menu, (el) => el.cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); this.pick(c); }))
        .child(c.icon ? image(c.icon).size(16).flex_none().when(Boolean(c.asleep), (el) => el.opacity(0.5)) : div().size(16).flex_none())      // the agent's logo (the program's own icon)
        .child(div().flex_1().min_w(0).truncate().when(on, (el) => el.font_semibold()).when(Boolean(c.asleep), (el) => el.text_color(t.dim)).when(c.preview, (el) => el.italic()).child(c.name))
        .when(Boolean(c.since), (el) => el.child(h_flex().flex_none().gap(4).items_center().text_size(10.5).text_color(t.dim)
          .when(Boolean(c.asleep), (m) => m.child(svg("mods/vnh-agents/moon.svg").size(12).flex_none()))      // asleep: the moon, as in the tab bar
          .child(div().child(`${c.asleep ? "" : c.status === "working" || c.status === "blocked" ? "" : "idle "}${duration(Date.now() - c.since)}`))))
        .when(Boolean(dot), (el) => el.child(div().size(7).rounded(4).bg(dot).flex_none()))
        .when(c.now, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("now")));
    };
    if (menu) {
      return v_flex().id("sw-menu").size_full().min_h(0).bg(t.background).text_color(t.foreground).p(8).gap(2)
        .overflow_y_scroll().track_scroll(this.scroll)
        .children(shown.map(row));
    }
    return v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground).p(8).gap(2)
      .children(shown.map(row))
      .when(n > ROWS, (el) => el.child(div().px(12).pt(4).text_size(11).text_color(t.dim).child(`${st.sel + 1} / ${st.items.length}`)));
  }
}

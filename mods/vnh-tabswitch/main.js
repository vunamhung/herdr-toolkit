// The tab switcher's popup: tabs of the space you are in (the repo), or of every space grouped under their space's name; the one the
// gesture is on highlighted. It only draws: vnh-tabs keeps the groups, the tabs and the highlight in shared "vnh.tabswitch" and moves
// the highlight as two fingers scroll (the HerdrPad agent sends the steps); where the scroll stops, that tab is selected (its space
// too) and the popup closes.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, shared } from "herdr";

const ROWS = 16;                         // lines shown (group headers count), scrolled around the highlight
const DOT = { working: "#e0a63a", blocked: "#d9649a", done: "#3fae6a", idle: null };

export default class TabSwitch extends View {
  init(_props, cx) {
    this.seen = "";
    cx.timer.every(60, (cx) => {
      const st = shared("vnh.tabswitch"), sig = st ? `${st.sel}|${st.items?.length}|${st.mode}` : "";
      if (sig !== this.seen) { this.seen = sig; cx.notify(); }
    });
  }

  render() {
    const t = theme(), st = shared("vnh.tabswitch") ?? { items: [], groups: [], sel: 0, mode: "space" };
    // The lines: a header before each group (in "space" mode, the one space's name), then its tabs.
    const lines = [];
    for (const g of st.groups ?? []) {
      lines.push({ head: g.name || "Tabs" });
      for (let i = g.first; i < g.first + g.count; i++) lines.push({ i });
    }
    const at = Math.max(0, lines.findIndex((l) => l.i === st.sel)), n = lines.length;
    const from = Math.max(0, Math.min(at - Math.floor(ROWS / 2), n - ROWS)), shown = lines.slice(from, from + ROWS);
    const row = (l, k) => {
      if (l.head !== undefined) return div().id(`sw-h-${from + k}`).flex_none().px(12).pt(k === 0 ? 2 : 8).pb(4).truncate().text_size(11).text_color(t.dim).child(l.head);
      const c = st.items[l.i], on = l.i === st.sel, dot = DOT[c.status] ?? null;
      return h_flex().id(`sw-${c.tab}`).h(32).flex_none().px(12).gap(9).items_center().rounded(7).text_size(13)
        .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .child(div().flex_1().min_w(0).truncate().when(on, (el) => el.font_semibold()).when(c.preview, (el) => el.italic()).child(c.name))
        .when(Boolean(dot), (el) => el.child(div().size(7).rounded(4).bg(dot).flex_none()))
        .when(c.now, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("now")));
    };
    return v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground).p(8).gap(2)
      .children(shown.map(row))
      .when(n > ROWS, (el) => el.child(div().px(12).pt(4).text_size(11).text_color(t.dim).child(`${st.sel + 1} / ${st.items.length}`)));
  }
}

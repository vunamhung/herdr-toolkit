// The tab switcher's popup: the tabs of the space you are in (the repo), the one the gesture is on highlighted. It only draws:
// vnh-tabs keeps the list and the highlight in shared "vnh.tabswitch" and moves the highlight as the two fingers scroll sideways
// (the HerdrPad agent sends the steps); where the scroll stops, that tab is selected and the popup closes.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, shared } from "herdr";

const ROWS = 14;
const DOT = { working: "#e0a63a", blocked: "#d9649a", done: "#3fae6a", idle: null };

export default class TabSwitch extends View {
  init(_props, cx) {
    this.seen = "";
    cx.timer.every(60, (cx) => {
      const st = shared("vnh.tabswitch"), sig = st ? `${st.sel}|${st.tabs?.length}` : "";
      if (sig !== this.seen) { this.seen = sig; cx.notify(); }
    });
  }

  render() {
    const t = theme(), st = shared("vnh.tabswitch") ?? { tabs: [], sel: 0, space: "" };
    const n = st.tabs.length, from = Math.max(0, Math.min(st.sel - Math.floor(ROWS / 2), n - ROWS)), shown = st.tabs.slice(from, from + ROWS);
    const row = (c, k) => {
      const i = from + k, on = i === st.sel, dot = DOT[c.status] ?? null;
      return h_flex().id(`sw-${c.id}`).h(32).flex_none().px(12).gap(9).items_center().rounded(7).text_size(13)
        .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .child(div().w(18).flex_none().text_size(11).text_color(t.dim).child(String(i + 1)))
        .child(div().flex_1().min_w(0).truncate().when(on, (el) => el.font_semibold()).when(c.preview, (el) => el.italic()).child(c.name))
        .when(Boolean(dot), (el) => el.child(div().size(7).rounded(4).bg(dot).flex_none()))
        .when(c.active, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("now")));
    };
    return v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground).p(8).gap(2)
      .child(div().px(12).pt(2).pb(6).truncate().text_size(11).text_color(t.dim).child(st.space || "Tabs"))
      .children(shown.map(row))
      .when(n > ROWS, (el) => el.child(div().px(12).pt(4).text_size(11).text_color(t.dim).child(`${st.sel + 1} / ${n}`)));
  }
}

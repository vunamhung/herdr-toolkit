// The cover of a sleeping agent (made by vnh-agents' sleep.js): where the agent's terminal was, the last screen it had,
// dimmed, and the agent is off. A click, Enter or Space wakes it (`vnh-agents.wake:<terminal>`): its resume command
// goes back into its terminal, which takes this pane's place. The screen is plain text (the terminal's colors aren't kept).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, shared, run, settings, layout } from "herdr";

// Where the terminal's first cell starts inside its pane: the layout's terminal_padding ([vertical, horizontal] or one number;
// the root sets it, the nearest node up the tree wins), else the setting.
function padding() {
  const find = (n) => (n && typeof n === "object" ? (n.terminal_padding != null ? n.terminal_padding : (n.children ?? []).reduce((h, c) => h ?? find(c), null)) : null);
  const v = find(layout()) ?? settings()?.terminal_padding ?? 0;
  return Array.isArray(v) ? [Number(v[0]) || 0, Number(v[1]) || 0] : [Number(v) || 0, Number(v) || 0];
}

export default class Cover extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.waking = false;
  }

  rec() {
    const id = props()?.id;
    return (shared("vnh.asleep") ?? []).find((r) => r.id === id) ?? null;
  }

  wake(cx) {
    const r = this.rec();
    if (!r || this.waking) return;
    this.waking = true; cx.notify();
    run(`vnh-agents.wake:${r.terminal}`);
  }

  render() {
    const t = theme(), r = this.rec();
    const names = { claude: "Claude Code", agy: "Antigravity", codex: "Codex" };
    const lines = (r?.screen ?? "").split("\n");
    // The terminal's own metrics, so a line sits where it sat in the live terminal: its font and size, and a row as tall as
    // its cell (the font's ~1.1 em line times terminal_line_height).
    const [PAD_Y, PAD_X] = padding();
    const st = settings() ?? {}, size = Number(st.font_size) || 15, lh = Number(st.terminal_line_height) || 1.4;
    const rowH = Math.round(size * 1.1 * lh * 100) / 100;
    // The terminal puts a glyph at the top of its cell; a line box centers it (adds half the leading above): measured against the
    // live terminal, the text sits 0.317 em too low, so the first row starts that much higher.
    const top = Math.max(0, PAD_Y - 0.317 * size);
    return v_flex().id("vnh-cover").size_full().min_h(0).relative().bg(t.background).cursor_pointer().overflow_hidden()
      .track_focus(this.handle)
      .on_click((_e, cx) => this.wake(cx))
      .on_key_down((e, cx) => { if (e.key === "enter" || e.key === "space") { cx.stop_propagation(); this.wake(cx); } })
      // the last screen, dimmed
      .child(v_flex().flex_1().min_h(0).px(PAD_X).pt(top).opacity(0.38).text_color(t.foreground).text_size(size)
        .when(typeof st.font === "string", (el) => el.font_family(st.font))
        .children(lines.map((l, i) => div().id(`l${i}`).whitespace_nowrap().h(rowH).line_height(`${rowH}px`).child(l === "" ? " " : l))))
      // a quiet hint at the bottom
      .child(h_flex().absolute().bottom(14).left(0).right(0).justify_center()
        .child(div().px(14).h(30).rounded(15).bg(t.raised).border_1().border_color(t.border).flex().items_center().text_size(12).text_color(t.muted)
          .child(this.waking || r?.waking ? "Waking…" : `${r ? names[r.agent] ?? "Agent" : "Agent"} is asleep · click to resume`)));
  }
}

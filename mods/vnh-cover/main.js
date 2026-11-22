// The cover of a sleeping agent (made by vnh-agents' sleep.js): where the agent's terminal was, the last screen it had,
// dimmed, and the agent is off. A click, Enter or Space wakes it (`vnh-agents.wake:<terminal>`): its resume command
// goes back into its terminal, which takes this pane's place. The screen is plain text (the terminal's colors aren't kept).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, shared, run, settings } from "herdr";

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
    return v_flex().id("vnh-cover").size_full().min_h(0).relative().bg(t.background).cursor_pointer().overflow_hidden()
      .track_focus(this.handle)
      .on_click((_e, cx) => this.wake(cx))
      .on_key_down((e, cx) => { if (e.key === "enter" || e.key === "space") { cx.stop_propagation(); this.wake(cx); } })
      // the last screen, dimmed
      .child(v_flex().flex_1().min_h(0).px(14).py(10).opacity(0.38).text_color(t.foreground).text_size(13 * (settings()?.zoom ?? 1) / (settings()?.zoom ?? 1))
        .children(lines.map((l, i) => div().id(`l${i}`).whitespace_nowrap().h(19).child(l === "" ? " " : l))))
      // a quiet hint at the bottom
      .child(h_flex().absolute().bottom(14).left(0).right(0).justify_center()
        .child(div().px(14).h(30).rounded(15).bg(t.raised).border_1().border_color(t.border).flex().items_center().text_size(12).text_color(t.muted)
          .child(this.waking || r?.waking ? "Waking…" : `${r ? names[r.agent] ?? "Agent" : "Agent"} is asleep · click to resume`)));
  }
}

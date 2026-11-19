import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, home, readTextFile, checking } from "herdr";

// Written by ~/.claude/statusline.sh on every Claude Code status refresh:
// { model, effort, five, five_reset, seven, seven_reset, updated } (resets/updated: unix seconds).
const LIMITS_FILE = "/.cache/claude-statusline/limits.json";

// "3h47m" / "2d13h" / "12m" until a unix-seconds reset time.
function untilReset(epoch) {
  if (!epoch) return "";
  const s = Math.max(0, Math.floor(epoch - Date.now() / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 60)}m`;
}

// Clone of Herdr's workspace-status with Claude Code's model and usage limits next to the agents count.
export default class ClaudeLimitsStatus extends View {
  init(_props, cx) {
    this.limits = null;
    if (checking()) return;
    this.refresh(cx);
    // Gentle poll: the file changes at most every few seconds, and timers keep running while hidden.
    cx.timer.every(5000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(home() + LIMITS_FILE);
        const next = text ? JSON.parse(text) : null;
        if (JSON.stringify(next) !== JSON.stringify(this.limits)) {
          this.limits = next;
          cx.notify();
        }
      } catch {
        // half-written or invalid file: keep the last good values
      }
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  // "14%/5h 3h47m": only the percentage is colored (green / yellow >=60 / red >=85); the rest
  // inherits the bar's text color and size like the other segments.
  limit(t, pct, windowLabel, reset) {
    const color = pct >= 85 ? t.blocked : pct >= 60 ? t.ansi3 : t.ansi2;
    return h_flex().gap(4).items_center()
      .child(div().text_color(color).child(`${pct}%`))
      .child(div().child(`/${windowLabel}`))
      .when(Boolean(reset), (el) => el.child(div().child(untilReset(reset))));
  }

  claude(t) {
    const l = this.limits;
    if (!l || !l.model) return null;
    const row = h_flex().gap(10).items_center()
      .child(div().child("|"))
      .child(div().child(l.effort ? `${l.model} (${l.effort})` : l.model));
    if (typeof l.five === "number") row.child(this.limit(t, l.five, "5h", l.five_reset));
    if (typeof l.seven === "number") row.child(this.limit(t, l.seven, "7d", l.seven_reset));
    return row;
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const claude = this.claude(t);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .when(Boolean(claude), el => el.child(claude))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}

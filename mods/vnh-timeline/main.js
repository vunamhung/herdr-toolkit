// A rail of ticks at the right edge of the terminal in front of you, one per prompt you sent in the agent
// that runs there (Claude Code, Antigravity, Codex). It replaces the scrollbar: the ticks brighten while the
// terminal scrolls, hovering the rail slides out what each prompt said, and a click scrolls the terminal to
// that prompt.
//
// How it finds them: the agents keep your prompts in their history files (~/.claude/history.jsonl,
// ~/.gemini/antigravity-cli/history.jsonl, ~/.codex/history.jsonl); the terminal's own text
// (`hc read`) says where each one is, because a prompt counts only if a line of the terminal starts
// with it. Rows: that text has one line per logical line, so the number of columns that makes its
// wrapped height equal the terminal's row count (`panes()[].scroll.total`) is searched for, then each
// prompt's row is counted. Only terminals with history are covered: a program on the alternate screen
// (Claude Code's fullscreen mode) has none to scroll, so there the rail is empty (use `/tui default`).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, focused, panes, hc, run, exec, home, placement, checking } from "herdr";

const HISTORIES = [".claude/history.jsonl", ".gemini/antigravity-cli/history.jsonl", ".codex/history.jsonl"];
const SHOWN = 14, LABEL = 230, EDGE = 20;

const norm = (s) => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
// Terminal cells a string takes: wide characters (CJK, emoji) count 2, combining marks 0.
function cells(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x300 && c <= 0x36f) continue;
    n += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || c >= 0x1f300 ? 2 : 1;
  }
  return n;
}
const rowsOf = (w, cols) => Math.max(1, Math.ceil(w / cols));

export default class Rail extends View {
  init(_props, cx) {
    this.term = null; this.total = 0; this.offset = 0; this.len = 0; this.items = []; this.scrolledAt = 0;
    this.built = { term: null, total: -1 }; this.busy = false; this.hist = { at: 0, list: [] };
    if (checking()) return;
    cx.timer.every(400, (cx) => this.tick(cx));
  }

  tick(cx) {
    const f = focused(), term = f?.terminal ?? null;
    const p = term ? panes().find((x) => x.terminal === term) : null;
    const s = p?.scroll ?? null;
    let changed = false;
    if (!s) { if (this.items.length || this.term !== term) { this.items = []; this.term = term; this.total = 0; this.built = { term, total: -1 }; changed = true; } if (changed) cx.notify(); return; }
    if (this.term !== term) { this.term = term; changed = true; }
    if (s.offset !== this.offset) { this.scrolledAt = Date.now(); changed = true; }
    Object.assign(this, { offset: s.offset, len: s.len });
    if (s.total !== this.total) { this.total = s.total; changed = true; }
    if ((this.built.term !== term || this.built.total !== s.total) && !this.busy) this.build(term, s.total, cx);
    // shown while it scrolls (and a moment after) or while the pointer is on it; else nothing is drawn
    const show = Date.now() - this.scrolledAt < 2500 || Boolean(placement()?.hovered);
    if (show !== this.lit) { this.lit = show; changed = true; }
    if (changed) cx.notify();
  }

  async prompts(cwd) {
    if (Date.now() - this.hist.at < 4000) return this.hist.list;
    const out = [];
    for (const rel of HISTORIES) {
      const r = await exec("tail", ["-n", "600", `${home()}/${rel}`]).catch(() => null);
      if (!r || r.code !== 0) continue;
      for (const line of String(r.stdout ?? "").split("\n")) {
        if (!line.trim()) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const text = norm(j.display ?? j.text ?? "");
        const dir = j.workspace ?? j.project ?? null;
        if (text.length < 6 || text.startsWith("/")) continue;
        if (dir && cwd && dir !== cwd) continue;
        out.push({ text, at: j.timestamp ?? (j.ts ? j.ts * 1000 : 0) });
      }
    }
    out.sort((a, b) => a.at - b.at);
    this.hist = { at: Date.now(), list: out };
    return out;
  }

  async build(term, total, cx) {
    this.busy = true;
    try {
      const pane = panes().find((x) => x.terminal === term);
      const [r, list] = await Promise.all([hc(["read", term, "--lines", String(Math.max(total, 50)), "--json"]), this.prompts(pane?.cwd ?? null)]);
      if (r?.code !== 0) return;
      let text; try { text = JSON.parse(r.stdout).text ?? ""; } catch { return; }
      const lines = text.split("\n"), widths = lines.map((l) => cells(l));
      // the column count whose wrapped height best matches the terminal's row count
      let best = 80, bestDiff = Infinity;
      for (let cols = 30; cols <= 400; cols++) {
        let sum = 0; for (const w of widths) sum += rowsOf(w, cols);
        const d = Math.abs(sum - total); if (d < bestDiff) { bestDiff = d; best = cols; }
      }
      const start = []; let acc = 0;
      for (const w of widths) { start.push(acc); acc += rowsOf(w, best); }
      const offsetFix = Math.max(0, total - acc); // blank screen rows `hc read` trims at the end
      const norms = lines.map((l) => norm(l));
      const found = []; let from = 0;
      for (const p of list) {
        const key = p.text.slice(0, 30);
        let hit = -1;
        for (let i = from; i < norms.length; i++) {
          const m = norms[i];
          const k = m.indexOf(key);
          if (k >= 0 && k <= 4 && /^[^\p{L}\p{N}]*$/u.test(m.slice(0, k))) { hit = i; break; }
        }
        if (hit >= 0) { found.push({ row: start[hit], text: p.text }); from = hit + 1; }
      }
      this.items = found; this.built = { term, total };
    } finally { this.busy = false; cx.notify(); }
  }

  jump(item) {
    if (!this.term) return;
    const target = Math.max(0, item.row - 1);
    run("terminal.scroll", { terminal: this.term, lines: target - this.offset });
  }

  render() {
    const t = theme(), pl = placement(), open = Boolean(pl?.hovered);
    const live = true;
    const all = this.items;
    if (!all.length || !(open || Date.now() - this.scrolledAt < 2500)) return div(); // nothing to show: a floating block that renders nothing isn't drawn at all
    // the window of prompts around where you are: the last SHOWN, or those around the viewport
    let cur = -1; for (let i = 0; i < all.length; i++) if (all[i].row <= this.offset + 1) cur = i;
    const first = Math.max(0, Math.min(all.length - SHOWN, cur - Math.floor(SHOWN / 2)));
    const rows = all.slice(first, first + SHOWN).map((it, k) => {
      const idx = first + k, on = idx === cur;
      return h_flex().id(`rail-${idx}`).h(22).w(LABEL + EDGE).items_center().justify_end().cursor_pointer()
        .on_click(() => this.jump(it))
        .child(div().flex_1().min_w(0).truncate().text_right().pr(8).text_size(11.5).text_color(on ? t.foreground : t.muted).child(it.text))
        .child(h_flex().w(EDGE).h(22).flex_none().items_center().justify_center()
          .child(div().h(2).w(on ? 12 : 8).rounded(1).bg(on ? t.accent : t.dim).opacity(live ? 1 : 0.35)));
    });
    return v_flex().w(LABEL + EDGE).py(2).children(rows);
  }
}

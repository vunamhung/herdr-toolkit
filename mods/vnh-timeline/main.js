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
import { theme, focused, panes, hc, run, exec, readTextFile, home, placement, checking, window } from "herdr";

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
    this.built = { term: null, total: -1, at: 0 }; this.busy = false; this.hist = { at: 0, sig: "", list: [] };
    if (checking()) return;
    cx.timer.every(400, (cx) => this.tick(cx));
  }

  tick(cx) {
    // Herdr in the background: a look every 3.2 s instead of every 400 ms.
    if (window()?.active === false && ((this.bgTick = (this.bgTick ?? 0) + 1) % 8)) return;
    const f = focused(), term = f?.terminal ?? null;
    const p = term ? panes().find((x) => x.terminal === term) : null;
    const s = p?.program?.agent ? (p.scroll ?? null) : null;
    let changed = false;
    if (!s) { if (this.items.length || this.term !== term) { this.items = []; this.term = term; this.total = 0; this.built = { term, total: -1, at: 0 }; changed = true; } if (changed) cx.notify(); return; }
    if (this.term !== term) { this.term = term; changed = true; }
    if (s.offset !== this.offset) { this.scrolledAt = Date.now(); changed = true; }
    Object.assign(this, { offset: s.offset, len: s.len });
    if (s.total !== this.total) { this.total = s.total; changed = true; }
    const sameTerm = this.built.term === term;
    const due = !sameTerm || (this.built.total !== s.total && Date.now() - this.built.at >= 1500);
    if (due && !this.busy) this.build(term, s.total, cx);
    // shown while it scrolls (and a moment after) or while the pointer is on it; else nothing is drawn
    const show = Date.now() - this.scrolledAt < 2500 || Boolean(placement()?.hovered);
    if (show !== this.lit) { this.lit = show; changed = true; }
    if (changed) cx.notify();
  }

  async prompts(cwd) {
    const cleanDir = (d) => (d ? String(d).replace(/\/+$/, "") : null);
    if (Date.now() - this.hist.at >= 4000) {
      const paths = HISTORIES.map((rel) => `${home()}/${rel}`);
      const st = await exec("sh", ["-c", 'for p; do [ -f "$p" ] && (stat -f "%m:%z" -- "$p" 2>/dev/null || stat -c "%Y:%s" -- "$p" 2>/dev/null) || echo "-"; done', "st", ...paths], { timeout: 5000 }).catch(() => null);
      const lines = (st?.stdout ?? "").split("\n");
      const sig = lines.slice(0, paths.length).join("|");
      this.hist.at = Date.now();
      if (sig !== this.hist.sig) {
        const all = [];
        for (let idx = 0; idx < paths.length; idx++) {
          if (!lines[idx] || lines[idx] === "-") continue;
          const path = paths[idx];
          let raw = await readTextFile(path).catch(() => null);
          if (raw == null) {
            const r = await exec("tail", ["-n", "3000", path]).catch(() => null);
            if (!r || r.code !== 0) continue;
            raw = String(r.stdout ?? "");
          }
          for (const line of raw.split("\n")) {
            if (!line.trim()) continue;
            let j; try { j = JSON.parse(line); } catch { continue; }
            const rawText = String(j.display ?? j.text ?? "");
            const text = norm(rawText);
            const rawLines = rawText.split(/\r?\n/).map(norm).filter(Boolean);
            const firstLine = rawLines[0] ?? text;
            const nextLine = rawLines[1] ?? "";
            const dir = cleanDir(j.workspace ?? j.project ?? null);
            if (text.length < 6 || text.startsWith("/")) continue;
            all.push({
              text,
              key: (firstLine.length >= 6 ? firstLine : text).slice(0, 30),
              next: firstLine.length < 25 && nextLine ? nextLine.slice(0, 16) : "",
              exact: !nextLine && firstLine.length < 30,
              dir,
              at: j.timestamp ?? (j.ts ? j.ts * 1000 : 0),
            });
          }
        }
        all.sort((a, b) => a.at - b.at);
        this.hist = { at: Date.now(), sig, list: all };
      }
    }
    const want = cleanDir(cwd);
    return want ? this.hist.list.filter((p) => !p.dir || p.dir === want) : this.hist.list;
  }

  async build(term, total, cx) {
    this.busy = true;
    try {
      const pane = panes().find((x) => x.terminal === term);
      const [r, g, list] = await Promise.all([
        hc(["read", term, "--lines", String(Math.max(total, 50)), "--json"]).catch(() => null),
        hc(["get", term, "--json"]).catch(() => null),
        this.prompts(pane?.cwd ?? null),
      ]);
      if (r?.code !== 0) { this.built = { term, total, at: Date.now() }; return; }
      let text; try { text = JSON.parse(r.stdout).text ?? ""; } catch { this.built = { term, total, at: Date.now() }; return; }
      let best = 0;
      if (g?.code === 0) { try { best = Number(JSON.parse(g.stdout).cols) || 0; } catch {} }
      const lines = text.split("\n"), widths = lines.map((l) => cells(l));
      if (!best) {
        // fallback: wrapped height decreases monotonically with cols, so binary search finds the best fit in O(log C * L).
        let lo = 30, hi = 400;
        const height = (cols) => { let sum = 0; for (const w of widths) sum += rowsOf(w, cols); return sum; };
        while (lo < hi) { const mid = (lo + hi) >> 1; if (height(mid) > total) lo = mid + 1; else hi = mid; }
        const h1 = height(lo), h0 = lo > 30 ? height(lo - 1) : Infinity;
        best = Math.abs(h0 - total) < Math.abs(h1 - total) ? lo - 1 : lo;
      }
      const start = []; let acc = 0;
      for (const w of widths) { start.push(acc); acc += rowsOf(w, best); }
      const offsetFix = Math.max(0, total - acc);
      const norms = lines.map((l) => norm(l));
      const found = []; let from = 0;
      for (const p of list) {
        const key = p.key;
        let hit = -1;
        for (let i = from; i < norms.length; i++) {
          const m = norms[i];
          const k = m.indexOf(key);
          if (k < 0 || k > 4 || !/^[^\p{L}\p{N}]*$/u.test(m.slice(0, k))) continue;
          if (p.exact && m.slice(k) !== key) continue;
          if (p.next && !norms.slice(i + 1, i + 3).some((l) => l.includes(p.next))) continue;
          hit = i; break;
        }
        if (hit >= 0) { found.push({ row: offsetFix + start[hit], text: p.text }); from = hit + 1; }
      }
      if (this.term !== term) return;
      this.items = found; this.built = { term, total, at: Date.now() };
    } finally { this.busy = false; cx.notify(); }
  }

  jump(item, cx) {
    if (!this.term) return;
    const s = panes().find((x) => x.terminal === this.term)?.scroll ?? null;
    const curOffset = s ? s.offset : this.offset;
    const maxOffset = s ? Math.max(0, s.total - s.len) : Math.max(0, this.total - this.len);
    const target = Math.max(0, Math.min(maxOffset, item.row - 1));
    const delta = Math.round(target - curOffset);
    this.scrolledAt = Date.now();
    if (delta !== 0) {
      run("terminal.scroll", { terminal: this.term, lines: delta });
      this.offset = target;
    }
    cx?.notify();
  }

  render() {
    const t = theme(), pl = placement(), open = Boolean(pl?.hovered);
    const all = this.items;
    if (!all.length || !(open || Date.now() - this.scrolledAt < 2500)) return div(); // nothing to show: a floating block that renders nothing isn't drawn at all
    // the window of prompts around where you are: the last SHOWN, or those around the viewport
    let cur = -1; for (let i = 0; i < all.length; i++) if (all[i].row <= this.offset + 1) cur = i;
    const first = Math.max(0, Math.min(all.length - SHOWN, cur - Math.floor(SHOWN / 2)));
    const rows = all.slice(first, first + SHOWN).map((it, k) => {
      const idx = first + k, on = idx === cur;
      return h_flex().id(`rail-${idx}`).h(22).w(LABEL + EDGE).items_center().justify_end().cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.jump(it, cx))
        .child(div().flex_1().min_w(0).truncate().text_right().pr(8).text_size(11.5).text_color(on ? t.foreground : t.muted).child(it.text))
        .child(h_flex().w(EDGE).h(22).flex_none().items_center().justify_center()
          .child(div().h(2).w(on ? 12 : 8).rounded(1).bg(on ? t.accent : t.dim)));
    });
    return v_flex().w(LABEL + EDGE).py(2).children(rows);
  }
}

// Cmd+A in an agent's terminal selects the text in its input box (Herdr's own selection, so Cmd+C copies it): Claude Code, Antigravity
// and Codex have no "select all" in their input. In any other terminal Cmd+A is what it was, `terminal.select_all`.
// How: the input box is found in the terminal's screen text (between the last two horizontal rules, as Claude Code and Antigravity
// draw it; else the last prompt line `❯ ` / `> ` / `› ` and the indented lines under it), and the selection starts after the prompt
// mark and runs to the end of the last line.
import { hc, run, focused, panes, terminals } from "herdr";

const RULE = /^\s*[─━═\-]{12,}\s*$/;
const PROMPT = /^(\s*[❯>›]\s)/;

/** { first, last, col } (screen row indexes and the column where the text starts), or null. */
export function findInput(lines) {
  const rules = lines.map((l, i) => (RULE.test(l) ? i : -1)).filter((i) => i >= 0);
  let first = -1, last = -1;
  if (rules.length >= 2) {
    const b = rules[rules.length - 1], a = rules[rules.length - 2];
    if (b - a >= 2) { first = a + 1; last = b - 1; }
  }
  if (first < 0) {
    for (let i = lines.length - 1; i >= 0; i--) if (PROMPT.test(lines[i])) { first = i; break; }
    if (first < 0) return null;
    last = first;
    for (let i = first + 1; i < lines.length && /^\s{2,}\S/.test(lines[i]) && !RULE.test(lines[i]); i++) last = i;
  }
  while (last > first && lines[last].trim() === "") last--;
  const m = PROMPT.exec(lines[first]);
  return { first, last, col: m ? m[1].length : 0 };
}

export async function selectInput(only) {
  const f = focused(), term = only ?? f?.terminal;
  if (!term) return run("terminal.select_all", {});
  const t = terminals().find((x) => x.address === term);
  if (!t?.program?.agent) return run("terminal.select_all", { terminal: term });
  const p = panes().find((x) => x.terminal === term);
  if (p?.scroll && p.scroll.from_bottom > 0) run("terminal.scroll", { terminal: term, to: "bottom" });
  const r = await hc(["read", term]).catch(() => null);
  const lines = String(r?.stdout ?? "").split("\n");
  const box = findInput(lines);
  if (!box) return run("terminal.select_all", { terminal: term });
  // Rows count from the oldest history through the active screen (on the alternate screen: just that screen).
  const base = p?.scroll ? p.scroll.total - lines.length : 0;
  run("terminal.select", { terminal: term, at: { row: base + box.first, col: box.col }, mode: "cell" });
  for (let i = box.first; i < box.last; i++) run("terminal.adjust_selection", { terminal: term, direction: "down" });
  run("terminal.adjust_selection", { terminal: term, direction: "line_end" });
}

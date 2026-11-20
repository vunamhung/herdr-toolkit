// Claude Code conversations (ctrl-i): every session in ~/.claude/projects, newest first, with its
// title (custom title, else the AI title, else the first prompt), folder, branch, prompt count and
// age. Type to search title, first prompt, folder and branch; ↑/↓, Enter resumes it in a new tab of
// the active space at its folder (`claude --resume <id>`), ⌘Enter copies its id, Esc closes.
//
// Reading is cheap on repeat: the file list with mtimes comes first (one stat each), then only the
// files that changed since the last look are read (grep, never whole files into the mod), and the
// result is cached in shared "vnh.sessions.cache".
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, props, closeOverlay, exec, run, spaces, shared, setShared, notify, home } from "herdr";

const ICON = (n) => `mods/vnh-sessions/${n}.svg`;
const CACHE = "vnh.sessions.cache.v2"; // v2: entries carry `sdk`
const LIMIT = 400;

const LIST = `root="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"; [ -d "$root" ] || exit 0
ls -t "$root"/*/*.jsonl 2>/dev/null | head -n "$1" | while IFS= read -r f; do
  m=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f"); printf '%s\\t%s\\n' "$m" "$f"; done`;
// For each file: its title record (last one), first real prompt, prompt count; one line each.
const READ = `for f in "$@"; do
  t=$(grep -E '"type":"(custom-title|ai-title|agent-name)"' "$f" | tail -n 1)
  u=$(grep -m 60 '"type":"user"' "$f" | grep -v -e '"isMeta":true' -e '"tool_result"' -e '"isSidechain":true' -e '"content":"<' -e '"text":"<' | head -n 1)
  n=$(grep '"type":"user"' "$f" | grep -c -v -e '"tool_result"' -e '"isMeta":true')
  e=$(grep -m 1 -o '"entrypoint":"[a-z-]*"' "$f")
  printf '@@%s\\n%s\\n%s\\n%s\\n%s\\n' "$f" "$n" "$t" "$u" "$e"
done`;

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
function promptText(rec) {
  const c = rec?.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join(" ") : "";
  return text.replace(/\s+/g, " ").trim();
}
function ago(sec) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
}

export default class Sessions extends View {
  init(_props, cx) {
    this.query = ""; this.at = 0; this.busy = false;
    this.cache = shared(CACHE) ?? {};
    this.order = Object.values(this.cache).filter((x) => !x.sdk).sort((a, b) => b.m - a.m);
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search conversations: title, prompt, folder, branch" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.open(this.rows()[this.at]));
    this.input.focus();
    cx.timer.after(250, () => this.input.focus());
    this.refresh(cx);
  }

  close() { closeOverlay(props()?.overlay); }

  refresh(cx) {
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const l = await exec("sh", ["-c", LIST, "list", String(LIMIT)], { timeout: 15000 }).catch(() => null);
        const files = (l?.stdout ?? "").split("\n").filter(Boolean).map((x) => { const [m, f] = x.split("\t"); return { m: Number(m), f }; });
        const next = {}, stale = [];
        for (const { m, f } of files) { const old = this.cache[f]; if (old && old.m === m) next[f] = old; else stale.push({ m, f }); }
        // Read changed files a few at a time, showing them as they come.
        for (let i = 0; i < stale.length; i += 8) {
          const batch = stale.slice(i, i + 8);
          const r = await exec("sh", ["-c", READ, "read", ...batch.map((x) => x.f)], { timeout: 60000 }).catch(() => null);
          const parts = (r?.stdout ?? "").split("@@").filter(Boolean);
          for (const part of parts) {
            const [f, n, t, u, e] = part.split("\n");
            const item = batch.find((x) => x.f === f); if (!item) continue;
            const tr = parse(t), ur = parse(u);
            const id = f.split("/").pop().replace(/\.jsonl$/, "");
            const title = tr?.customTitle ?? tr?.title ?? tr?.aiTitle ?? tr?.agentName ?? "";
            // `claude -p` runs (tools such as the AI commit button) aren't conversations: kept in the
            // cache so they aren't read again, but never listed.
            const sdk = /"sdk-/.test(e ?? "");
            next[f] = { f, id, m: item.m, n: Number(n) || 0, title, prompt: promptText(ur).slice(0, 240), cwd: ur?.cwd ?? null, branch: ur?.gitBranch ?? null, sdk };
          }
          this.cache = { ...this.cache, ...next };
          setShared(CACHE, { ...(shared(CACHE) ?? {}), ...next }); // saved as it goes: the popup may close mid-way
          this.order = Object.values(next).concat(stale.slice(i + 8).map((x) => this.cache[x.f]).filter(Boolean)).filter((x) => !x.sdk).sort((a, b) => b.m - a.m);
          cx.notify();
        }
        this.cache = next;
        this.order = Object.values(next).filter((x) => !x.sdk).sort((a, b) => b.m - a.m);
        setShared(CACHE, next);
      } finally { this.busy = false; cx.notify(); }
    });
  }

  rows() {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.order;
    const words = q.split(/\s+/);
    const scored = [];
    for (const s of this.order) {
      const title = (s.title || "").toLowerCase(), hay = `${title} ${s.prompt.toLowerCase()} ${(s.cwd ?? "").toLowerCase()} ${(s.branch ?? "").toLowerCase()} ${s.id}`;
      if (!words.every((w) => hay.includes(w))) continue;
      scored.push({ s, rank: words.every((w) => title.includes(w)) ? 0 : 1 });
    }
    return scored.sort((a, b) => a.rank - b.rank).map((x) => x.s);
  }

  open(s) {
    if (!s) return;
    this.close();
    const space = spaces().find((x) => x.active);
    run("tab.new", { space: space?.id, folder: s.cwd ?? undefined, name: (s.title || s.prompt || "claude").slice(0, 40),
      argv: ["sh", "-lc", 'exec claude --resume "$1"', "resume", s.id] });
  }

  render() {
    const t = theme(), rows = this.rows(), h = home();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const tilde = (p) => (p && h && p.startsWith(h) ? "~" + p.slice(h.length) : p ?? "");
    const listH = Math.min(460, Math.max(60, rows.length * 52 + 8));
    return v_flex().id("vnh-sessions").track_focus(this.handle).w_full().bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") { cx.stop_propagation(); this.close(); return; }
        if (!rows.length) return;
        if (k === "enter" && e.modifiers?.platform) { cx.write_to_clipboard(rows[this.at].id); notify({ title: "Copied the session id", body: rows[this.at].id, level: "info", timeout: 2500 }); cx.stop_propagation(); return; }
        if (k === "down") this.at = (this.at + 1) % rows.length;
        else if (k === "up") this.at = (this.at + rows.length - 1) % rows.length;
        else return;
        this.scroll.scroll_to_item(this.at);
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(ICON("search")).size(14).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.busy ? "Reading…" : `${rows.length} of ${this.order.length}`)))
      .child(v_flex().id("vnh-sessions-rows").h(listH).flex_none().p(4).gap(2).overflow_y_scrollbar().track_scroll(this.scroll)
        .when(!rows.length, (el) => el.child(div().p(12).text_size(12).text_color(t.dim).child(this.busy ? "Reading conversations…" : "No conversation matches")))
        .children(rows.map((s, i) => {
          const on = i === this.at;
          const title = s.title || s.prompt || "(no prompt)";
          return v_flex().id(`ses-${s.id}`).h(50).flex_none().px(10).py(5).gap(3).justify_center().rounded(7).cursor_pointer()
            .when(on, (el) => el.bg(t.accent + "33")).hover((st) => st.bg(t.hover))
            .on_click(() => this.open(s))
            .child(h_flex().gap(8).items_center()
              .child(svg(ICON("chat")).size(13).flex_none().text_color(on ? t.accent : t.muted))
              .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).when(on, (el) => el.font_medium()).child(title))
              .child(div().flex_none().text_size(11).text_color(t.dim).child(`${s.n} prompt${s.n === 1 ? "" : "s"} · ${ago(s.m)}`)))
            .child(h_flex().pl(21).gap(8).items_center().text_size(11).text_color(t.dim)
              .child(div().flex_none().max_w(260).truncate().child(tilde(s.cwd) || "?"))
              .when(Boolean(s.branch), (el) => el.child(h_flex().flex_none().gap(3).items_center()
                .child(svg(ICON("branch")).size(10).flex_none()).child(div().max_w(140).truncate().child(s.branch))))
              .when(Boolean(s.title && s.prompt), (el) => el.child(div().flex_1().min_w(0).truncate().child(s.prompt))));
        })))
      .child(h_flex().h(26).flex_none().px(12).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child(div().flex_1().child("Enter resumes in a new tab · ⌘Enter copies the id · Esc"))
        .child(div().child("claude --resume")));
  }
}

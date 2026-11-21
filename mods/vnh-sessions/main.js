// Agent conversations (ctrl-i): Claude Code, Antigravity (agy) and Codex sessions, newest first; chips filter by
// agent and by Herdr space (a session belongs to the space whose folder holds its own). Claude Code: every session in ~/.claude/projects, with its
// title (custom title, else the AI title, else the first prompt), folder, branch, prompt count and
// age. Type to search title, first prompt, folder and branch; ↑/↓, Enter resumes it in a new tab of
// the active space at its folder (`claude --resume <id>`), ⌘Enter copies its id, Esc closes.
//
// Reading is cheap on repeat: the file list with mtimes comes first (one stat each), then only the
// files that changed since the last look are read (grep, never whole files into the mod), and the
// result is cached in shared "vnh.sessions.cache".
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, props, closeOverlay, exec, run, spaces, shared, setShared, notify, home, panes } from "herdr";

const AGENTS = { claude: "Claude", agy: "Antigravity", codex: "Codex" };
const RESUME = { claude: 'exec claude --resume "$1"', agy: 'exec agy --conversation "$1"', codex: 'exec codex resume "$1"' };

// Antigravity and Codex sessions, one JSON object per line: { agent, id, m (unix s), n (prompts), title, prompt, cwd }.
// agy keeps no per-conversation title: its history file has every prompt with its conversation id and folder.
// Codex: the rollout files in ~/.codex/sessions (first line the session's id and folder, then the messages).
const OTHERS = `python3 - <<'PY'
import glob, json, os, re, sys
home = os.path.expanduser("~")
out = []
def clean(t): return re.sub(r"\s+", " ", t or "").strip()
hist = os.path.join(home, ".gemini/antigravity-cli/history.jsonl")
if os.path.exists(hist):
    convs = {}
    for line in open(hist, encoding="utf-8", errors="replace"):
        try: j = json.loads(line)
        except Exception: continue
        cid = j.get("conversationId")
        if not cid: continue
        c = convs.setdefault(cid, {"first": None, "n": 0, "m": 0, "cwd": None})
        t = clean(j.get("display"))
        if c["first"] is None and t: c["first"] = t[:240]
        c["n"] += 1
        c["m"] = max(c["m"], (j.get("timestamp") or 0) / 1000)
        c["cwd"] = j.get("workspace") or c["cwd"]
    for cid, c in convs.items():
        db = os.path.join(home, ".gemini/antigravity-cli/conversations", cid + ".db")
        if os.path.exists(db): c["m"] = max(c["m"], os.path.getmtime(db))
        out.append({"agent": "agy", "id": cid, "m": int(c["m"]), "n": c["n"], "title": "", "prompt": c["first"] or "", "cwd": c["cwd"]})
files = sorted(glob.glob(os.path.join(home, ".codex/sessions/**/rollout-*.jsonl"), recursive=True), key=os.path.getmtime, reverse=True)[:300]
for f in files:
    sid = cwd = None; first = None; n = 0
    try:
        with open(f, encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if i > 4000: break
                try: j = json.loads(line)
                except Exception: continue
                p = j.get("payload") or {}
                if j.get("type") == "session_meta":
                    sid = p.get("id") or sid; cwd = p.get("cwd") or cwd
                elif j.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
                    t = clean(" ".join(x.get("text", "") for x in p.get("content", []) if isinstance(x, dict)))
                    if t and not t.startswith("<"):
                        n += 1
                        if first is None: first = t[:240]
    except Exception: continue
    if sid and n: out.append({"agent": "codex", "id": sid, "m": int(os.path.getmtime(f)), "n": n, "title": "", "prompt": first or "", "cwd": cwd})
for o in out: print(json.dumps(o))
PY`;

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
    this.hover = null; this.confirm = null; // the row under the pointer, the one asking ✓ / ✗
    this.agentF = null; this.spaceF = null; // chips: one agent, one space (null: all)
    this.others = (shared("vnh.sessions.others") ?? []);
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
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", OTHERS], { timeout: 20000 }).catch(() => null);
      const list = (r?.stdout ?? "").split("\n").map(parse).filter((x) => x?.id);
      if (r?.code === 0) { this.others = list; setShared("vnh.sessions.others", list); cx.notify(); }
    });
  }

  // Every conversation of every agent, newest first.
  all() { return this.order.concat(this.others).sort((a, b) => b.m - a.m); }

  // The space whose folder holds the conversation's (the longest folder wins, so a worktree space beats its repo).
  spaceOf(s) {
    const cwd = s.cwd ?? ""; let best = null;
    for (const sp of spaces()) {
      const f = (sp.folder ?? "").replace(/\/$/, "");
      if (f && (cwd === f || cwd.startsWith(f + "/")) && (!best || f.length > best.folder.length)) best = { id: sp.id, name: sp.name, folder: f };
    }
    return best;
  }

  // Conversations open in a Herdr pane right now. Herdr doesn't name a terminal's session, but
  // Claude Code titles its terminal with the session's title: a Claude pane whose title and folder
  // match a conversation's is that conversation. -> Map("title\0cwd" -> { pane, space, tab label })
  openPanes() {
    const names = new Map();
    for (const sp of spaces()) for (const tb of sp.tabs ?? []) names.set(tb.id, { space: sp.name, tab: tb.name, spaceId: sp.id });
    const out = new Map();
    for (const p of panes()) {
      if (p.app !== "claude-code" || !p.title) continue;
      const title = p.title.replace(/^[^\p{L}\p{N}]+/u, "").trim(), where = names.get(p.tab);
      out.set(`${title}\0${p.cwd ?? ""}`, { pane: p.pane, label: where ? `${where.space} · ${where.tab}` : "open", spaceId: where?.spaceId });
    }
    return out;
  }

  liveOf(s, open) { return s.title ? open.get(`${s.title}\0${s.cwd ?? ""}`) ?? null : null; }

  rows() {
    const q = this.query.trim().toLowerCase();
    const base = this.all().filter((s) => (!this.agentF || (s.agent ?? "claude") === this.agentF) && (!this.spaceF || (this.spaceF === "none" ? !this.spaceOf(s) : this.spaceOf(s)?.id === this.spaceF)));
    if (!q) return base;
    const open = this.openPanes();
    const words = q.split(/\s+/);
    const scored = [];
    for (const s of base) {
      const live = this.liveOf(s, open);
      const title = (s.title || "").toLowerCase(), hay = `${title} ${(live?.label ?? "").toLowerCase()} ${s.prompt.toLowerCase()} ${(s.cwd ?? "").toLowerCase()} ${(s.branch ?? "").toLowerCase()} ${s.id}`;
      if (!words.every((w) => hay.includes(w))) continue;
      scored.push({ s, rank: words.every((w) => title.includes(w) || (live?.label ?? "").toLowerCase().includes(w)) ? 0 : 1 });
    }
    return scored.sort((a, b) => a.rank - b.rank).map((x) => x.s);
  }

  // Moves the conversation to the Trash (Finder, so Put Back works): its .jsonl and its <id>/ folder
  // (subagents, tool results). A conversation written in the last 5 min, or one a `claude --resume`
  // process has open, is refused: it may be live and still writing.
  remove(s, cx) {
    this.confirm = null;
    if (Date.now() / 1000 - s.m < 300) { notify({ title: "Not deleted: the conversation is active", body: "It was written in the last 5 minutes. Close it first.", level: "warning", timeout: 5000 }); cx.notify(); return; }
    cx.spawn(async (cx) => {
      const live = await exec("sh", ["-c", 'ps -ax -o args= | grep -F -- "$1" | grep -v grep | grep -q claude && echo live; true', "ps", s.id]).catch(() => null);
      if ((live?.stdout ?? "").includes("live")) { notify({ title: "Not deleted: the conversation is open", body: "A claude --resume process uses it.", level: "warning", timeout: 5000 }); return; }
      const dir = s.f.replace(/\.jsonl$/, "");
      const script = 'on run argv\ntell application "Finder"\nrepeat with p in argv\ndelete (POSIX file (contents of p) as alias)\nend repeat\nend tell\nend run';
      const args = ["-e", script, s.f];
      const hasDir = await exec("test", ["-d", dir]).then((r) => r.code === 0).catch(() => false);
      if (hasDir) args.push(dir);
      const r = await exec("osascript", args).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) {
        const { [s.f]: _gone, ...rest } = shared(CACHE) ?? {};
        setShared(CACHE, rest);
        delete this.cache[s.f];
        this.order = this.order.filter((x) => x.f !== s.f);
        notify({ title: "Moved to the Trash", body: s.title || s.prompt || s.id, level: "success", timeout: 3000 });
      } else notify({ title: "Couldn't delete the conversation", body: (r.stderr || "").trim(), level: "error", timeout: 6000 });
      cx.notify();
    });
  }

  open(s) {
    if (!s) return;
    this.close();
    // Already open in a pane: go there instead of resuming a second copy.
    const live = this.liveOf(s, this.openPanes());
    if (live) { if (live.spaceId) run("space.select", { id: live.spaceId }); run("pane.focus", { pane: live.pane }); return; }
    const space = spaces().find((x) => x.active);
    const agent = s.agent ?? "claude";
    run("tab.new", { space: space?.id, folder: s.cwd ?? undefined, name: (s.title || s.prompt || agent).slice(0, 40),
      argv: ["sh", "-lc", RESUME[agent], "resume", s.id] });
  }

  render() {
    const t = theme(), rows = this.rows(), h = home(), open = this.openPanes();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const tilde = (p) => (p && h && p.startsWith(h) ? "~" + p.slice(h.length) : p ?? "");
    // Same frame as the cmd-enter command popup (vnh-command): a framed input, a hint row, the list.
    const listH = Math.min(360, Math.max(40, rows.length * 51));
    // Chips: the agents that have conversations, then the spaces that hold some (busiest first, "Other" for
    // folders no space holds). A chip counts what it would show with the other chip row as it is now.
    const all = this.all(), inSpace = (x) => !this.spaceF || (this.spaceF === "none" ? !this.spaceOf(x) : this.spaceOf(x)?.id === this.spaceF);
    const inAgent = (x) => !this.agentF || (x.agent ?? "claude") === this.agentF;
    const agentCount = {}, spaceCount = new Map(); let none = 0;
    for (const x of all) { if (inSpace(x)) agentCount[x.agent ?? "claude"] = (agentCount[x.agent ?? "claude"] ?? 0) + 1; }
    for (const x of all) { if (!inAgent(x)) continue; const sp = this.spaceOf(x); if (sp) spaceCount.set(sp.id, { name: sp.name, n: (spaceCount.get(sp.id)?.n ?? 0) + 1 }); else none++; }
    const chip = (id, label, count, on, action) => h_flex().id(id).h(22).flex_none().px(9).gap(5).items_center().rounded(11).cursor_pointer().text_size(11.5)
      .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .hover((st) => st.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(); this.at = 0; cx.notify(); })
      .child(div().max_w(150).truncate().child(label)).when(count != null, (el) => el.child(div().text_color(t.dim).text_size(10.5).child(String(count))));
    const agentChips = Object.keys(AGENTS).filter((k) => agentCount[k] || this.agentF === k).map((k) => chip(`ag-${k}`, AGENTS[k], agentCount[k] ?? 0, this.agentF === k, () => { this.agentF = this.agentF === k ? null : k; }));
    const spaceChips = [...spaceCount.entries()].sort((a, b) => b[1].n - a[1].n).map(([id, v]) => chip(`sp-${id}`, v.name, v.n, this.spaceF === id, () => { this.spaceF = this.spaceF === id ? null : id; }))
      .concat(none ? [chip("sp-none", "Other", none, this.spaceF === "none", () => { this.spaceF = this.spaceF === "none" ? null : "none"; })] : []);
    return v_flex().id("vnh-sessions").track_focus(this.handle).w_full().p(14).gap(10).bg(t.popover).text_size(13)
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
      .child(h_flex().h(40).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg(ICON("search")).size(15).flex_none().text_color(t.muted))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.busy ? "Reading…" : `${rows.length} of ${all.length}`)))
      .when(agentChips.length + spaceChips.length > 0, (el) => el.child(v_flex().gap(6)
        .when(agentChips.length > 0, (c) => c.child(h_flex().gap(6).flex_wrap().children(agentChips)))
        .when(spaceChips.length > 0, (c) => c.child(h_flex().gap(6).flex_wrap().children(spaceChips)))))
      .child(h_flex().px(4).text_size(11).text_color(t.dim)
        .child(div().flex_1().child(this.query.trim() ? "Matches" : "Newest first"))
        .child(div().child("↑↓ choose · Enter resume · ⌘Enter copy id · Esc")))
      .child(v_flex().id("vnh-sessions-rows").h(listH).flex_none().gap(1).overflow_y_scrollbar().track_scroll(this.scroll)
        .when(!rows.length, (el) => el.child(div().p(12).text_size(12).text_color(t.dim).child(this.busy ? "Reading conversations…" : "No conversation matches")))
        .children(rows.map((s, i) => {
          const on = i === this.at;
          const title = s.title || s.prompt || "(no prompt)", live = this.liveOf(s, open);
          const own = (s.agent ?? "claude") === "claude", asking = own && this.confirm === s.f, shown = own && (asking || this.hover === s.f);
          // Bare icons, no box: they brighten under the pointer.
          const small = (id, icon, color, tip, action) => div().id(id).size(20).flex_none().flex().items_center().justify_center()
            .text_color(color).opacity(0.8).cursor_pointer().tooltip(tip)
            .hover((st) => st.opacity(1))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
            .child(svg(ICON(icon)).size(13));
          const agent = s.agent ?? "claude";
          return v_flex().id(`ses-${agent}-${s.id}`).relative().h(50).flex_none().px(10).py(5).gap(3).justify_center().rounded(7).cursor_pointer()
            .when(on, (el) => el.bg(t.selection ?? t.selected)).hover((st) => st.bg(t.hover))
            .on_hover((over, cx) => { const next = over ? (s.f ?? s.id) : this.hover === (s.f ?? s.id) ? null : this.hover; if (next !== this.hover) { this.hover = next; if (!over && this.confirm === s.f) this.confirm = null; cx.notify(); } })
            .on_click(() => this.open(s))
            // VNH: on hover a trash at the right edge; a press asks ✓ / ✗ right beside it.
            .when(shown, (el) => el.child(h_flex().absolute().right(8).top(5).h(20).gap(6).items_center()
              .when(asking, (r) => r
                .child(small(`del-yes-${s.id}`, "check", t.ansi2, "Move to the Trash", (cx) => this.remove(s, cx)))
                .child(small(`del-no-${s.id}`, "x", t.muted, "Keep it", (cx) => { this.confirm = null; cx.notify(); })))
              .when(!asking, (r) => r.child(small(`del-${s.id}`, "trash", t.ansi1, "Delete this conversation", (cx) => { this.confirm = s.f; cx.notify(); })))))
            .child(h_flex().gap(8).items_center()
              .child(svg(ICON("chat")).size(13).flex_none().text_color(on ? t.accent : t.muted))
              .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).when(on, (el) => el.font_medium()).child(title))
              // Open in a Herdr tab now: which one (Enter goes there).
              .when(Boolean(live) && !shown, (el) => el.child(h_flex().flex_none().gap(4).items_center().text_size(10.5).text_color(t.ansi2)
                .child(div().size(6).rounded(3).bg(t.ansi2)).child(div().max_w(160).truncate().child(live.label))))
              // Hidden on hover, where the trash (and its ✓ / ✗) take the spot.
              .when(!shown, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`${s.n} prompt${s.n === 1 ? "" : "s"} · ${ago(s.m)}`))))
            .child(h_flex().pl(21).gap(8).items_center().text_size(11).text_color(t.dim)
              .child(div().flex_none().text_color(t.muted).child(AGENTS[agent]))
              .child(div().flex_none().max_w(240).truncate().child(tilde(s.cwd) || "?"))
              .when(Boolean(s.branch), (el) => el.child(h_flex().flex_none().gap(3).items_center()
                .child(svg(ICON("branch")).size(10).flex_none()).child(div().max_w(140).truncate().child(s.branch))))
              .when(Boolean(s.title && s.prompt), (el) => el.child(div().flex_1().min_w(0).truncate().child(s.prompt))));
        })));
  }
}

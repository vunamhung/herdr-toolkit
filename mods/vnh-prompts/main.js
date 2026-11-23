// Derived from `over9k-prompts` of herunan/herdr-over9k (MIT, herdr-over9k, the Over9k authors, https://github.com/herunan/herdr-over9k); modified for herdr-toolkit. See THIRD-PARTY-NOTICES.md.
// The Timeline: your prompts in the agent you're in, the right panel's "Timeline"
// (a child of the panel-body stack, id "prompts"; the tab bar has its button,
// over9k-options turns both off). Newest first, on a line with a dot each: the
// prompt, when you sent it, how long the agent worked on it and when it finished
// (or that it's still working), the tokens it wrote (↓, as the CLI counts them:
// while it works, the CLI's own counter, read off its screen, since the transcript
// only gets a message's tokens once it's finished), the files it changed and
// the commands it ran, and the start of its reply. Click one, or ↑/↓ then Enter,
// to read the whole prompt and the reply (Markdown) here; Esc closes it.
// Claude Code agents only: claude-info.py (Over9k's sidebar runs it; on its own, this
// mod's copy) says which conversation runs in each terminal, from Claude Code's own
// session files (~/.cache/over9k/agents/<terminal>.json); prompts.py reads it.
// Followed: the agent you're in, else the last one you were in.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { theme, exec, home, appHome, focused, agents, panes, readTextFile, hc, run, spaces, setShared } from "herdr";
import { loadConvos, repoRoot, ago, AGENT_ICON } from "./convos.js";

// Python 3 runs as "python3", else "python" (as on Windows): found once.
let PY = null;
const python = (args) => (PY ??= exec("python3", ["-c", "1"]).then((r) => (r?.code === 0 ? "python3" : "python"), () => "python"))
  .then((p) => exec(p, args));

const PAGE = 40;
const RESUME = { claude: 'exec claude --resume "$1"', agy: 'exec agy --conversation "$1"', codex: 'exec codex resume "$1"' };
const ICON = (n) => `mods/vnh-prompts/${n}.svg`;
const READER = () => `${appHome()}/mods/vnh-prompts/prompts.py`;
const pad = (n) => String(n).padStart(2, "0");

// "15:30" today, "yesterday 9:00", "mon 15:30", else the date.
function when(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const now = new Date(), day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = Math.round((day(now) - day(d)) / 86400000), hm = `${d.getHours()}:${pad(d.getMinutes())}`;
  if (diff === 0) return hm;
  if (diff === 1) return `yesterday ${hm}`;
  if (diff < 7) return `${["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getDay()]} ${hm}`;
  return d.toLocaleDateString();
}
// Plain text from Markdown, on one line.
const plain = (s) => (s ?? "").replace(/```[\s\S]*?```/g, " ").replace(/\*\*|__|`|^#+\s*|^>\s*/gm, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
// "45s", "5m 12s", "1h 3m".
function took(a, b) {
  const s = Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000));
  if (isNaN(s)) return "";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
  return `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60 ? ` ${Math.floor(s / 60) % 60}m` : ""}`;
}
// "840", "12.3k", "1.2M".
const count = (n) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`);
const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${d.getHours()}:${pad(d.getMinutes())}`; };
// The start of the reply to a prompt.
function summary(p) {
  // Its first sentence (two when the first is a word or two, like "Done.").
  const parts = plain(p.reply).split(/(?<=[.!?])\s/);
  const first = (parts[0]?.length < 25 && parts[1] ? `${parts[0]} ${parts[1]}` : parts[0]) ?? "";
  return first.length > 140 ? `${first.slice(0, 139)}…` : first;
}

export default class Prompts extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.agent = null; // the terminal followed
    this.transcript = null;
    this.size = null; // the transcript's size when last read
    this.prompts = [];
    this.open = null; // the index read in full
    this.at = 0; // the keyboard's row (newest first)
    this.note = "Open an agent to see its prompts";
    this.shown = PAGE; // how many cards are drawn (newest first); a long session has hundreds, and drawing them all ran past the render time limit
    this.memo = new Map(); // per prompt: its text and reply as plain words, worked out once
    // VNH: a toggle in the header switches between the timeline of the agent in view and the list of this repository's conversations.
    let saved = null; try { saved = localStorage.getItem("vnh-timeline-mode"); } catch {}
    this.mode = saved === "convos" ? "convos" : "timeline";
    this.convos = null; this.convosAt = 0; this.convosBusy = false; this.convosRoot = null; this.convoShown = 50; this.curSession = null; this.rootOf = new Map(); this.spaceCwd = new Map();
    this.follow(cx);
    cx.timer.every(2000, (cx) => { this.follow(cx); this.viewCwd(); if (this.mode === "convos") this.loadConvos(cx); if (agents().find((x) => x.address === this.agent)?.status === "working") this.readLive(cx); else this.live = null; });
  }

  // The agent you're in (else the last one), its transcript, re-read when it grows.
  follow(cx) {
    const f = focused();
    const here = f?.agent ?? (f?.terminal && agents().some((a) => a.address === f.terminal) ? f.terminal : null);
    if (here && here !== this.agent) { this.agent = here; this.transcript = null; this.size = null; this.open = null; this.at = 0; this.prompts = []; this.shown = PAGE; cx.notify(); }
    if (!this.agent || this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        let info = await readTextFile(`${home()}/.cache/over9k/agents/${this.agent}.json`).catch(() => null);
        // On its own (no sidebar keeps those files): run claude-info.py here.
        if (!info) {
          const own = `${appHome()}/mods/vnh-prompts/claude-info.py`;
          const r = await python(["-I", (await readTextFile(own).catch(() => null)) != null ? own : `${appHome()}/mods/over9k/claude-info.py`]).catch(() => null);
          try { info = JSON.stringify(JSON.parse(r?.stdout || "{}")[this.agent] ?? null); } catch {}
        }
        let path = null;
        try { path = info && JSON.parse(info)?.transcript; } catch {}
        // Without that file: Claude Code's folder for the agent's
        // working directory (the reader takes its newest conversation).
        const a = agents().find((x) => x.address === this.agent);
        const cwd = panes().find((p) => p.terminal === this.agent)?.cwd;
        const claude = a && (a.app === "claude-code" || a.program?.key === "claude" || /claude/i.test(a.program?.name ?? ""));
        if (!path && claude && cwd) path = `${home()}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}`;
        if (!path) { this.note = "The timeline shows Claude Code agents"; this.prompts = []; this.transcript = null; cx.notify(); return; }
        // Read only when it has grown (the reader checks its size).
        const r = await python(["-I", READER(), path, this.transcript && this.size != null ? `${this.transcript}\t${this.size}` : ""]).catch(() => null);
        let got = null;
        try { got = JSON.parse(r?.stdout ?? ""); } catch {}
        const list = got?.prompts;
        if (!Array.isArray(list)) return;
        this.prompts = list.reverse().map((p) => this.decorate(p));
        this.context = got.context ?? 0;
        this.transcript = got.path ?? path;
        this.size = got.size ?? null;
        this.note = this.prompts.length ? "" : "No prompts yet";
        if (this.at >= this.prompts.length) this.at = 0;
        cx.notify();
      } finally {
        this.busy = false;
      }
    });
  }

  setMode(mode, cx) {
    this.mode = mode;
    try { localStorage.setItem("vnh-timeline-mode", mode); } catch {}
    if (mode === "convos") this.loadConvos(cx, true);
    cx.notify();
  }

  // This repository's conversations: the git top level of the folder of the agent in view (else of the focused terminal), read at most
  // every 30 s, and at once when the repository changes.
  // The folder the list is about: that of the terminal in front of you; while a preview or this panel has the focus, the one you were
  // last in within this space (else any agent of the space). Not "the last agent followed": that may be in another space.
  viewCwd() {
    const f = focused(), space = spaces().find((s) => s.active), ps = panes();
    const own = f?.terminal ? ps.find((x) => x.terminal === f.terminal)?.cwd : null;
    if (own && space) { this.spaceCwd.set(space.id, own); return own; }
    if (space && this.spaceCwd.get(space.id)) return this.spaceCwd.get(space.id);
    const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
    const inSpace = ps.filter((p) => p.terminal && tabs.has(p.tab));
    return (inSpace.find((p) => p.status) ?? inSpace[0])?.cwd ?? null;
  }

  loadConvos(cx, force = false) {
    if (this.convosBusy) return;
    const cwd = this.viewCwd();
    if (!cwd) return;
    this.convosBusy = true;
    cx.spawn(async (cx) => {
      try {
        let root = this.rootOf.get(cwd);
        if (root === undefined) { root = await repoRoot(cwd); this.rootOf.set(cwd, root); }
        if (!root) { this.convos = []; this.convosRoot = null; cx.notify(); return; }
        if (!force && root === this.convosRoot && this.convos && Date.now() - this.convosAt < 30000) return;
        if (root !== this.convosRoot) { this.convos = null; this.convoShown = 50; }
        this.convosRoot = root;
        // The conversation the agent in view is in, to mark it.
        const here = focused()?.terminal ?? null;
        const st = here ? await readTextFile(`${home()}/.cache/herdr-status/${here}.json`).then((x) => JSON.parse(x ?? "null")).catch(() => null) : null;
        this.curSession = st?.session ?? this.curSession; // kept while a preview has the focus
        const list = await loadConvos(root, (part) => { if (root === this.convosRoot) { this.convos = part; cx.notify(); } });
        if (root === this.convosRoot) { this.convos = list; this.convosAt = Date.now(); }
        cx.notify();
      } finally { this.convosBusy = false; }
    });
  }

  // A click on a conversation: its preview in a tab of its own (one per space; another click switches it).
  openPreview(s) {
    const space = spaces().find((x) => x.active);
    if (!space) return;
    const cur = space.tabs.find((t) => t.active)?.id ?? null;
    const doc = { agent: s.agent ?? "claude", id: s.id, f: s.f ?? "", cwd: s.cwd ?? "", title: s.title ?? "", branch: s.branch ?? "", n: s.n ?? 0, prompt: s.prompt ?? "", back: cur };
    const ids = new Set(space.tabs.map((t) => t.id));
    const pv = panes().find((p) => p.mod === "vnh-convo" && ids.has(p.tab));
    if (pv) {
      if (cur === pv.tab) doc.back = null;
      setShared("vnh.convo.open", { pane: pv.pane, doc, n: Date.now() });
      run("tab.select", { id: pv.tab });
    } else run("tab.new", { space: space.id, name: (doc.title || doc.prompt || "Conversation").slice(0, 40), mod: "vnh-convo", props: doc });
  }

  // The ▶ on a row: back to the pane that already runs it, else start it again in a new tab at its folder.
  async resumeConvo(s) {
    for (const a of agents()) {
      const st = await readTextFile(`${home()}/.cache/herdr-status/${a.address}.json`).then((x) => JSON.parse(x ?? "null")).catch(() => null);
      if (st?.session && st.session === s.id) {
        const p = panes().find((x) => x.terminal === a.address);
        const sp = spaces().find((x) => (x.tabs ?? []).some((t) => t.id === p?.tab));
        if (sp) run("space.select", { id: sp.id });
        if (p) { run("tab.select", { id: p.tab }); run("pane.focus", { pane: p.pane }); }
        return;
      }
    }
    const space = spaces().find((x) => x.active);
    run("tab.new", { space: space?.id, folder: s.cwd ?? undefined, name: (s.title || s.prompt || s.agent || "claude").slice(0, 40), argv: ["sh", "-lc", RESUME[s.agent ?? "claude"] ?? RESUME.claude, "resume", s.id] });
  }

  // `plain(text)` and the reply's summary cost a few regular expressions over text that can be long; they are worked out once per prompt
  // (again only when its reply grew), not on every draw.
  decorate(p) {
    const key = `${p.at}|${(p.text ?? "").length}|${(p.reply ?? "").length}`;
    let m = this.memo.get(key);
    if (!m) {
      m = { pt: plain(p.text), sm: summary(p), also: (p.also ?? []).map((x) => plain(x.text)) };
      if (this.memo.size > 3000) this.memo.clear();
      this.memo.set(key, m);
    }
    p.pt = m.pt; p.sm = m.sm; p.alsoPlain = m.also;
    return p;
  }

  // The working agent's own counter, from the bottom of its screen: Claude Code's
  // "(2m 5s · ↓ 11.4k tokens · …)". Null when it isn't showing.
  readLive(cx) {
    const at = this.agent;
    cx.spawn(async (cx) => {
      const r = await hc(["read", at]).catch(() => null);
      const lines = (r?.stdout ?? "").split("\n").filter((l) => /\(\s*(?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*·\s*↓\s*[\d.]+k?\s*tokens/.test(l));
      const m = /\(\s*(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s\s*·\s*↓\s*([\d.]+)(k?)\s*tokens/.exec(lines.pop() ?? "");
      this.live = at === this.agent && m ? { secs: (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + +m[3], tokens: Math.round(parseFloat(m[4]) * (m[5] ? 1000 : 1)) } : null;
      cx.notify();
    });
  }

  name() {
    const a = agents().find((x) => x.address === this.agent);
    return a?.tab_name || a?.program?.name || "";
  }

  // The switch of the header: shows what a click goes to.
  modeButton(t) {
    const convos = this.mode === "convos";
    return div().id("tl-mode").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(convos ? "Timeline of this conversation" : "Conversations of this repository")
      .accessibility_label(convos ? "Show the timeline" : "Show the conversations")
      .on_click((_e, cx) => this.setMode(convos ? "timeline" : "convos", cx))
      .child(svg(ICON(convos ? "timeline" : "convos")).size(15).flex_none());
  }

  renderConvos(t) {
    const list = this.convos, root = this.convosRoot;
    const rows = (list ?? []).slice(0, this.convoShown).map((s, i) => {
      const agent = s.agent ?? "claude", cur = Boolean(this.curSession) && s.id === this.curSession;
      const title = (s.title || s.prompt || s.id).replace(/\s+/g, " ").trim();
      // One line each: the icon, the title, then how old and how many prompts, so twice as many fit.
      const meta = [ago(s.m), s.n ? `${s.n} prompt${s.n > 1 ? "s" : ""}` : "", s.branch ?? ""].filter(Boolean).join(" · ");
      return h_flex().id(`convo-${s.id}`).flex_none().h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((x) => x.bg(t.hover))
        .tooltip(`${title} · ${meta}`)
        .on_click((_e, cx) => { this.openPreview(s); cx.notify(); })
        .child(image(AGENT_ICON[agent] ?? AGENT_ICON.claude).size(13).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).when(cur, (el) => el.font_semibold()).child(title))
        .when(cur, (el) => el.child(div().size(6).flex_none().rounded(3).bg(t.accent)))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${ago(s.m)}${s.n ? ` · ${s.n}` : ""}`))
        .child(div().id(`resume-${s.id}`).size(20).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim)
          .hover((x) => x.bg(t.raised).text_color(t.accent)).tooltip("Resume this conversation")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.resumeConvo(s); })
          .child(svg(ICON("play")).size(10).flex_none()));
    });
    return v_flex().id("over9k-prompts").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.modeButton(t))
        .when((list?.length ?? 0) > 0, (el) => el.child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
          .child(`${list.length} conversation${list.length > 1 ? "s" : ""}`)))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(root ? root.split("/").pop() : "")))
      .when(list === null, (el) => el.child(div().px(14).py(10).text_size(12).text_color(t.dim).child("Reading the conversations…")))
      .when(list !== null && list.length === 0, (el) => el.child(div().px(14).py(10).text_size(12).text_color(t.dim).child(root ? "No conversations in this repository yet" : "Open an agent in a repository to see its conversations")))
      .child(v_flex().id("convos-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(4).pt(4).pb(6).gap(0)
        .children(rows)
        .when((list?.length ?? 0) > this.convoShown, (el) => el.child(div().id("convos-more").h(32).flex_none().mx(4).flex().items_center().justify_center().rounded(8).cursor_pointer()
          .text_size(12).text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.convoShown += 50; cx.notify(); })
          .child(`Show ${Math.min(50, list.length - this.convoShown)} older · ${list.length - this.convoShown} not shown`))));
  }

  render(cx) {
    const t = theme();
    if (this.mode === "convos") return this.renderConvos(t);
    const list = this.prompts, view = list.slice(0, this.shown);
    const working = agents().find((x) => x.address === this.agent)?.status === "working";
    const item = (p, i) => {
      const on = this.open === i, picked = this.at === i, live = i === 0 && working;
      const last = i === view.length - 1 && list.length <= this.shown;
      // Plain words, joined by dots: done at, time worked, tokens, files, commands.
      const facts = [
        live ? "working" : p.done ? `done ${hhmm(p.done)}` : "",
        live && this.live ? took(0, this.live.secs * 1000) : p.done ? took(p.at, live ? new Date().toISOString() : p.done) : "",
        live && this.live ? `↓ ${count(this.live.tokens)} tokens` : p.tokens ? `↓ ${count(p.tokens)} tokens` : "",
        p.edits.length ? `${p.edits.length} file${p.edits.length > 1 ? "s" : ""}` : "",
        p.cmds ? `${p.cmds} command${p.cmds > 1 ? "s" : ""}` : "",
      ].filter(Boolean);
      // The line and its dot, then the card.
      return h_flex().id(`prompt-${i}`).items_stretch().gap(8).cursor_pointer()
        .on_click((_e, cx) => { this.at = i; this.open = on ? null : i; this.handle.focus(); cx.notify(); })
        .child(v_flex().w(14).flex_none().items_center()
          .child(div().w(2).h(14).bg(i === 0 ? t.background : t.border))
          .child(div().size(10).flex_none().rounded(5).border_2().border_color(live ? t.working : picked || on ? t.accent : t.border).bg(live ? t.working : t.background))
          .child(div().w(2).flex_1().bg(last ? t.background : t.border)))
        .child(v_flex().flex_1().min_w(0).my(4).px(10).py(7).gap(4).rounded(8)
          .bg(on || picked ? t.raised : t.background).border_1().border_color(on ? t.accent : picked ? t.border : t.background).hover((x) => x.bg(t.hover))
          .child(h_flex().gap(6).text_size(10.5).text_color(t.dim)
            .child(div().child(`#${list.length - i}`)).child(div().child(when(p.at))).child(div().flex_1()))
          .child(div().text_size(12.5).line_height("17px").text_color(t.foreground)
            .when(!on, (el) => el.truncate().child(p.pt)).when(on, (el) => el.whitespace_normal().child(p.text)))
          // Messages you sent while it worked on this one.
          .when(p.also?.length > 0 && !on, (el) => el.child(div().text_size(11).text_color(t.dim).truncate()
            .child(`+ ${p.also.length} more message${p.also.length > 1 ? "s" : ""}: ${(p.alsoPlain ?? []).join(" · ")}`)))
          .when(p.also?.length > 0 && on, (el) => el.child(v_flex().gap(3).pl(8).border_l(2).border_color(t.border)
            .children(p.also.map((m) => h_flex().gap(6).items_start().text_size(12).line_height("16px")
              .child(div().flex_none().text_size(10.5).text_color(t.dim).pt(1).child(hhmm(m.at)))
              .child(div().flex_1().min_w(0).whitespace_normal().text_color(t.foreground).child(m.text))))))
          .when(facts.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim).truncate()
            .when(live, (el) => el.child(h_flex().gap(0).child(div().text_color(t.working).child(facts[0])).child(div().child(` · ${facts.slice(1).join(" · ")}`))))
            .when(!live, (el) => el.child(facts.join(" · ")))))
          .when(!on && Boolean(p.reply), (el) => el.child(div().text_size(11.5).line_height("16px").text_color(t.muted).truncate().child(p.sm)))
          // Read in full: the reply as Markdown, then what it changed.
          .when(on, (el) => el.child(v_flex().mt(4).pt(6).gap(6).border_t_1().border_color(t.border)
            .child(p.reply ? TextView.markdown(`reply-${list.length - i}`, p.reply).selectable(true).text_size(12.5) : div().text_size(12).text_color(t.dim).child(live ? "Working…" : "(no reply text)"))
            .when(p.edits.length > 0, (el) => el.child(v_flex().gap(1).text_size(11).text_color(t.dim)
              .child(div().child("Changed"))
              .children(p.edits.map((x) => div().truncate().text_color(t.muted).child(x.replace(home(), "~")))))))));
    };
    return v_flex().id("over9k-prompts").track_focus(this.handle).size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (!list.length) return;
        if (e.key === "down") { this.at = Math.min(list.length - 1, this.at + 1); if (this.at >= this.shown - 1) this.shown += PAGE; }
        else if (e.key === "up") this.at = Math.max(0, this.at - 1);
        else if (e.key === "enter") this.open = this.open === this.at ? null : this.at;
        else if (e.key === "escape") this.open = null;
        else return;
        if (this.open != null && e.key !== "enter" && e.key !== "escape") this.open = this.at;
        cx.notify();
      })
      .child(h_flex().h(42).flex_none().pl(10).pr(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.modeButton(t))
        // VNH: no "Timeline" title here; the tab bar's Timeline button already names the panel.
        .when(list.length > 0, (el) => el.child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
          .child(`${list.length} prompt${list.length > 1 ? "s" : ""}`)))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.name()))
        // As the CLI words them: ↓ what it wrote this session, and the context it holds now.
        .when(list.length > 0, (el) => el.child(div().flex_none().text_size(12).text_color(t.dim)
          .child([`↓ ${count(list.reduce((n, p, i) => n + (i === 0 && working && this.live ? this.live.tokens : p.tokens || 0), 0))}`,
            this.context ? `context ${count(this.context)}` : ""].filter(Boolean).join(" · ")))))
      .when(Boolean(this.note), (el) => el.child(div().px(14).py(10).text_size(12).text_color(t.dim).child(this.note)))
      .child(v_flex().id("prompts-scroll").flex_1().min_h(0).overflow_y_scrollbar().pl(8).pr(8).pt(6).pb(8)
        .children(view.map(item))
        // The older ones, a page at a time.
        .when(list.length > this.shown, (el) => el.child(div().id("prompts-more").h(32).flex_none().mx(8).mb(6).flex().items_center().justify_center().rounded(8).cursor_pointer()
          .text_size(12).text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.shown += PAGE; cx.notify(); })
          .child(`Show ${Math.min(PAGE, list.length - this.shown)} older · ${list.length - this.shown} not shown`))));
  }
}

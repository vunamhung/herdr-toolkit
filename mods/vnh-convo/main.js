// A conversation (Claude Code, Antigravity or Codex) read in its own tab: opened from the Timeline panel's list of this repository's
// conversations. Your prompts and what the agent answered, newest first, a page at a time.
//   props: { agent, id, f (the conversation's file), cwd, title, branch, n, back: the tab to return to on close }
// Keys (the tab takes the keyboard when it opens): Esc closes it and goes back; Enter, or a click on Resume, brings the conversation
// back to life (`claude --resume <id>`, and the same for agy and Codex), or goes to it when it is already open in a pane.
// One preview tab per space: opening another conversation asks this copy to switch (shared "vnh.convo.open", read by its pane).
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { theme, props, run, exec, spaces, panes, agents, readTextFile, home, appHome, window, shared, setShared, nextCommand } from "herdr";

const RESUME = { claude: 'exec claude --resume "$1"', agy: 'exec agy --conversation "$1"', codex: 'exec codex resume "$1"' };
const AGENT_ICON = { claude: "icons/claude.svg", agy: "icons/antigravity.svg", codex: "icons/codex.svg" };
const AGENT_NAME = { claude: "Claude Code", agy: "Antigravity", codex: "Codex" };
const PAGE = 20;
const FONT = "PragmataPro";
const pad = (n) => String(n).padStart(2, "0");

function when(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const now = new Date(), day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = Math.round((day(now) - day(d)) / 86400000), hm = `${d.getHours()}:${pad(d.getMinutes())}`;
  if (diff === 0) return hm;
  if (diff === 1) return `yesterday ${hm}`;
  if (diff < 7) return `${["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getDay()]} ${hm}`;
  return `${d.toLocaleDateString()} ${hm}`;
}

export default class Convo extends View {
  init(_props, cx) {
    this.doc = this.docOf(props() ?? {});
    this.turns = null; this.note = ""; this.shown = PAGE; this.closing = false;
    this.kb = cx.focus_handle();
    this.seenOpen = shared("vnh.convo.open")?.n ?? 0;
    // This copy's own pane (a mod pane isn't told its id): claimed from the unclaimed vnh-convo panes, retrying until its tab exists.
    this.myPane = null; this.showing = false;
    const claim = () => {
      const all = panes().filter((p) => p.mod === "vnh-convo"), live = new Set(all.map((p) => p.pane));
      const taken = Object.fromEntries(Object.entries(shared("vnh.convo.panes") ?? {}).filter(([pane]) => live.has(pane)));
      const active = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id;
      const free = all.filter((p) => !taken[p.pane]);
      const mine = free.find((p) => p.tab === active) ?? free[free.length - 1];
      if (!mine) return false;
      this.myPane = mine.pane;
      setShared("vnh.convo.panes", { ...taken, [mine.pane]: this.doc.id ?? true });
      return true;
    };
    let tries = 0;
    const tryClaim = () => { if (!this.myPane && !claim() && ++tries < 20) cx.timer.after(100, tryClaim); };
    tryClaim();
    // Takes the keyboard when this tab shows, never from elsewhere.
    cx.timer.every(250, (cx) => {
      const me = this.myPane && panes().find((p) => p.pane === this.myPane);
      const active = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id;
      const showing = Boolean(me && window()?.active && active === me.tab);
      if (showing && !this.showing) this.kb.focus();
      this.showing = showing;
      const ask = shared("vnh.convo.open");
      if (ask && ask.n > this.seenOpen && this.myPane && ask.pane === this.myPane) {
        this.seenOpen = ask.n;
        this.switchTo(ask.doc, cx);
      }
    });
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); if (c === "focus") { this.kb.focus(); cx.notify(); } } });
    this.load(cx);
  }

  docOf(p) {
    return { agent: p.agent ?? "claude", id: p.id ?? "", f: p.f ?? "", cwd: p.cwd ?? "", title: p.title ?? "", branch: p.branch ?? "", n: p.n ?? 0, back: p.back ?? null, prompt: p.prompt ?? "" };
  }

  switchTo(doc, cx) {
    this.doc = { ...this.docOf(doc), back: doc.back ?? this.doc.back };
    this.turns = null; this.note = ""; this.shown = PAGE;
    const me = this.myPane && panes().find((p) => p.pane === this.myPane);
    if (me) { run("tab.rename", { id: me.tab, name: this.label().slice(0, 40) }); run("tab.select", { id: me.tab }); }
    this.kb.focus();
    this.load(cx);
    cx.notify();
  }

  label() { return (this.doc.title || this.doc.prompt || "").replace(/\s+/g, " ").trim() || AGENT_NAME[this.doc.agent] || "Conversation"; }

  load(cx) {
    const d = this.doc, token = (this.token = (this.token ?? 0) + 1);
    cx.spawn(async (cx) => {
      const r = await exec("python3", ["-I", `${appHome()}/mods/vnh-convo/convo.py`, d.agent, d.id, d.f, `${appHome()}/mods/vnh-prompts/prompts.py`], { timeout: 30000 }).catch(() => null);
      if (token !== this.token) return;
      try { const j = JSON.parse(r?.stdout ?? ""); this.turns = (j.turns ?? []).reverse(); this.note = j.note ?? ""; }
      catch { this.turns = []; this.note = "Could not read this conversation."; }
      cx.notify();
    });
  }

  // Esc: close this tab (once: a re-delivered key would close an already closed tab) and go back to where it was opened from.
  close(back = true) {
    if (this.closing) return;
    const me = panes().find((p) => p.pane === this.myPane);
    if (!me) return;
    this.closing = true;
    run("tab.close", { id: me.tab, confirmed: true });
    if (back && this.doc.back) run("tab.select", { id: this.doc.back });
  }

  // Enter / the Resume button: go to the pane that already runs it, else start it again in a new tab at its folder.
  async resume() {
    const d = this.doc;
    for (const a of agents()) {
      const st = await readTextFile(`${home()}/.cache/herdr-status/${a.address}.json`).then((x) => JSON.parse(x ?? "null")).catch(() => null);
      if (st?.session && st.session === d.id) {
        const p = panes().find((x) => x.terminal === a.address);
        const sp = spaces().find((s) => (s.tabs ?? []).some((t) => t.id === p?.tab));
        if (sp) run("space.select", { id: sp.id });
        if (p) { run("tab.select", { id: p.tab }); run("pane.focus", { pane: p.pane }); }
        this.close(false);
        return;
      }
    }
    const space = spaces().find((x) => x.active);
    run("tab.new", { space: space?.id, folder: d.cwd || undefined, name: this.label().slice(0, 40), argv: ["sh", "-lc", RESUME[d.agent] ?? RESUME.claude, "resume", d.id] });
    this.close(false);
  }

  render() {
    const t = theme(), d = this.doc, turns = this.turns, view = (turns ?? []).slice(0, this.shown);
    const card = (p, i) => {
      const n = turns.length - i;
      return v_flex().id(`turn-${n}`).flex_none().gap(6).py(10).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).text_size(10.5).text_color(t.dim).child(div().child(`#${n}`)).child(div().child(when(p.at))))
        .child(div().text_size(13).text_color(t.foreground).whitespace_normal().child(p.text))
        .when(Boolean(p.reply), (el) => el.child(v_flex().pl(10).border_l(2).border_color(t.border)
          .child(TextView.markdown(`reply-${d.id}-${n}`, p.reply.length > 20000 ? `${p.reply.slice(0, 20000)}…` : p.reply).text_size(12.5))));
    };
    return v_flex().id("convo-view").track_focus(this.kb).size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .on_mouse_down("left", () => this.kb.focus())
      .on_key_down((e, cx) => {
        const m = e.modifiers ?? {};
        if (m.control || m.alt || m.platform || m.shift || e.is_held) return;
        if (e.key === "escape") { cx.stop_propagation(); this.close(); }
        else if (e.key === "enter") { cx.stop_propagation(); this.resume(); }
      })
      .child(h_flex().h(46).flex_none().px(16).gap(10).items_center().border_b(1).border_color(t.border).text_size(12).font_family(FONT)
        .child(image(AGENT_ICON[d.agent] ?? AGENT_ICON.claude).size(16).flex_none())
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().font_semibold().text_size(13).child(this.label()))
          .child(div().truncate().text_size(11).text_color(t.dim).child([d.cwd.replace(home(), "~"), d.branch, d.n ? `${d.n} prompt${d.n > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · "))))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc close · Enter resume"))
        .child(h_flex().id("convo-resume").h(28).flex_none().px(12).gap(6).items_center().rounded(7).cursor_pointer().bg(t.accent).text_color(t.background)
          .font_semibold().hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => { cx.stop_propagation(); this.resume(); })
          .child("Resume")))
      .child(div().id("convo-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().w_full().max_w(880).mx_auto().px(28).py(12).text_size(13).font_family(FONT)
          .when(turns === null, (el) => el.child(div().text_color(t.dim).py(10).child("Loading…")))
          .when(Boolean(this.note), (el) => el.child(div().text_color(t.dim).text_size(12).py(6).child(this.note)))
          .children(view.map(card))
          .when(turns !== null && turns.length > this.shown, (el) => el.child(div().id("convo-more").h(34).flex_none().flex().items_center().justify_center().rounded(8).cursor_pointer()
            .my(8).text_size(12).text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.shown += PAGE; cx.notify(); })
            .child(`Show ${Math.min(PAGE, turns.length - this.shown)} earlier · ${turns.length - this.shown} not shown`)))));
  }
}

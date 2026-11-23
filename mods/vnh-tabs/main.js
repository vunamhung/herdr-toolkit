// Derived from Herdr's `tabs` 0.1.16 (Apache-2.0, Herdr, https://github.com/ogulcancelik/herdr); modified for herdr-toolkit. See THIRD-PARTY-NOTICES.md.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, nextCommand, focused, checking, exec, notify, readTextFile, home } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same as the agents mod: drops a status glyph, keeps a leading bracket or quote.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title, as the agents list does; a name the person gave stays.
function label(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  // agy sets no terminal title (its command line shows instead): the one status/agy.sh found, from the conversation.
  const given = (shared("vnh.titles") ?? {})[lead.terminal];
  const live = given ? clean(given) : clean(lead.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && (given || !path) && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

// The last terminal folder focused per space (shared "vnh.lastCwd"), for the run bar, the cmd-enter
// popup and the status bar, so a focused mod pane doesn't send them to the space's starting folder.
// Kept here because the tab bar is always in the VNH layout (the Files panel may be another mod).
function rememberWorkFolder() {
  const space = spaces().find((s) => s.active), f = focused();
  if (!space || !f) return;
  const pane = f.pane ? panes().find((p) => p.pane === f.pane) : null;
  const cwd = pane?.terminal ? pane.cwd : (f.pane === null && f.terminal ? f.cwd : null);
  if (!cwd) return;
  const map = shared("vnh.lastCwd") ?? {};
  if (map[space.id] !== cwd) setShared("vnh.lastCwd", { ...map, [space.id]: cwd });
}

export default class Tabs extends View {
  // The title each agent terminal's status file carries (agy), published in shared "vnh.titles" for the agents list too.
  async readTitles() {
    const out = {};
    for (const p of panes()) {
      if (!p.terminal || !p.program?.agent) continue;
      try { const j = JSON.parse((await readTextFile(`${home()}/.cache/herdr-status/${p.terminal}.json`)) ?? "null"); if (j?.title) out[p.terminal] = j.title; } catch {}
    }
    if (JSON.stringify(out) !== JSON.stringify(shared("vnh.titles") ?? {})) setShared("vnh.titles", out);
  }

  init(_props, cx) {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    if (!checking()) cx.timer.every(2000, () => this.readTitles());
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
    if (!checking()) { rememberWorkFolder(); cx?.timer.every(1000, () => rememberWorkFolder()); }
    try { this.focus = JSON.parse(localStorage.getItem("timelineFocus") ?? "null"); } catch { this.focus = null; }
    // keys.json: "vnh-tabs.timeline" (cmd-shift-b) toggles the Timeline the same way as its button.
    // "vnh-tabs.insights": the Insights toolbar button; "vnh-tabs.insights-close": Esc in the dashboard.
    cx?.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand()).replace(/^vnh-tabs\./, "");
        if (c === "timeline") this.toggleTimeline();
        else if (c === "insights") this.toggleInsights();
        else if (c === "insights-close") this.closeInsights();
        else if (c === "files" || c === "changes" || c === "graph") this.togglePanel(c);
        // "vnh-tabs.git-push" (cmd-\): push the work folder's branch and its tags, no dialog.
        else if (c === "git-push") this.gitPush();
        else if (c === "git-pull") this.gitPull();
        cx.notify();
      }
    });
  }

  // "vnh-tabs.files" (cmd-e), "vnh-tabs.changes" (alt-a), "vnh-tabs.graph": what the panel's
  // button does: close it when it already shows that panel, otherwise show that panel.
  // VNH: cmd-\ pushes the current branch of the repo you work in (the last terminal folder of the
  // active space), then its tags: to its upstream, else to origin (or the first remote) with
  // --set-upstream. Never forced; GIT_TERMINAL_PROMPT=0 so a missing login fails instead of hanging.
  gitPush() {
    if (this.pushing) return;
    const space = spaces().find((s) => s.active);
    const cwd = (shared("vnh.lastCwd") ?? {})[space?.id] ?? space?.folder;
    if (!cwd) return;
    this.pushing = true;
    const script = [
      'cd "$1" || exit 2',
      'b=$(git symbolic-ref -q --short HEAD) || { echo "HEAD is detached: check out a branch first" >&2; exit 3; }',
      'up=$(git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null)',
      'if [ -n "$up" ]; then r=${up%%/*}; git push --quiet "$r" "HEAD:${up#*/}" || exit 4',
      'else r=$(git remote | grep -x origin || git remote | head -n 1); [ -n "$r" ] || { echo "This repository has no remote" >&2; exit 5; }',
      '  git push --quiet --set-upstream "$r" "$b" || exit 4; fi',
      'git push --quiet "$r" --tags || exit 6',
      'echo "$r $b"',
    ].join("\n");
    notify({ title: "Pushing…", body: cwd.split("/").pop(), level: "info", timeout: 2500 });
    exec("env", ["GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=0", "sh", "-c", script, "push", cwd], { on: space?.machine ?? null, timeout: 120000 })
      .then((r) => {
        const out = (r.stdout ?? "").trim().split(/\s+/), err = (r.stderr ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
        if (r.code === 0) notify({ title: `Pushed ${out[1] ?? "branch"} and tags to ${out[0] ?? "remote"}`, level: "success", timeout: 4000 });
        else if (r.code === 6) notify({ title: "Pushed the branch; tags were refused", body: err, level: "warning", timeout: 8000 });
        else notify({ title: "Push failed", body: err || `git exited ${r.code}`, level: "error", timeout: 8000 });
      })
      .catch((e) => notify({ title: "Push failed", body: String(e?.message ?? e), level: "error", timeout: 8000 }))
      .finally(() => { this.pushing = false; });
  }

  // VNH: pull the work folder's branch, fast-forward only (a pinch out over the bars).
  gitPull() {
    if (this.pulling) return;
    const space = spaces().find((s) => s.active);
    const cwd = (shared("vnh.lastCwd") ?? {})[space?.id] ?? space?.folder;
    if (!cwd) return;
    this.pulling = true;
    notify({ title: "Pulling…", body: cwd.split("/").pop(), level: "info", timeout: 2500 });
    exec("env", ["GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=0", "git", "pull", "--ff-only"], { cwd, on: space?.machine ?? null, timeout: 120000 })
      .then((r) => {
        const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").filter(Boolean);
        if (r.code === 0) notify({ title: /up to date/i.test(out.join(" ")) ? "Already up to date" : "Pulled", body: out.pop() ?? "", level: "success", timeout: 4000 });
        else notify({ title: "Pull failed", body: out.pop() ?? `git exited ${r.code}`, level: "error", timeout: 8000 });
        setShared("vnh.git.changed", Date.now());
      })
      .catch((e) => notify({ title: "Pull failed", body: String(e?.message ?? e), level: "error", timeout: 8000 }))
      .finally(() => { this.pulling = false; });
  }

  // VNH: the side panel (Files / Changes) and the Timeline share one width (this.width, kept in
  // localStorage). Dragging whichever shows sets it; the one that shows next opens at it, and the
  // hidden one is kept at it too.
  syncWidths(panel, timeline) {
    const pw = panel?.size?.px, tw = timeline?.size?.px;
    if (!pw || !tw) return;
    const visible = !panel.hidden ? "panel" : !timeline.hidden ? "timeline" : null;
    if (this.width === undefined) { try { this.width = Number(localStorage.getItem("sideWidth")) || null; } catch { this.width = null; } }
    if (!visible) { this.shownSide = null; return; }
    const vw = visible === "panel" ? pw : tw, hidden = visible === "panel" ? "timeline" : "panel", hw = visible === "panel" ? tw : pw;
    if (visible !== this.shownSide) {
      // Just shown: take the shared width (unless there is none yet).
      this.shownSide = visible;
      if (this.width && Math.abs(vw - this.width) >= 1) { run("layout.resize", { id: visible, px: Math.round(this.width) }); return; }
    }
    if (!this.width || Math.abs(vw - this.width) >= 1) {
      this.width = vw;
      try { localStorage.setItem("sideWidth", String(Math.round(vw))); } catch {}
    }
    if (Math.abs(hw - this.width) >= 1) run("layout.resize", { id: hidden, px: Math.round(this.width) });
  }

  // VNH: one right-side view at a time. Showing Files / Changes / Git while the Timeline shows
  // closes the Timeline for good (no panel to bring back: the person just picked one).
  leaveTimeline() {
    const timeline = find(layout(), "timeline");
    if (!timeline || timeline.hidden) return;
    this.focus = null;
    this.saveFocus();
    run("layout.hide", { id: "timeline" });
    this.timelineShown = false;
    this.timelineWant = { shown: false, until: Date.now() + 1000 };
  }

  togglePanel(id) {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel || !body?.children?.some((c) => c.id === id)) return;
    if (!panel.hidden && body.active === id) run("layout.hide", { id: "panel" });
    else { this.leaveTimeline(); run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
  }

  // VNH: the Insights tab takes the whole work area. Opening it hides the right panel and the
  // Timeline and remembers what was open (this.insights); closing it (button again, Esc, or its
  // tab's ×) brings that back and returns to the tab you came from.
  insightsPane() {
    const space = spaces().find((s) => s.active), ids = new Set(space?.tabs.map((t) => t.id) ?? []);
    return { space, pane: panes().find((p) => p.mod === "insights" && ids.has(p.tab)) };
  }

  toggleInsights() {
    const { space, pane } = this.insightsPane(), current = space?.tabs.find((t) => t.active)?.id;
    if (pane && pane.tab === current) return this.closeInsights();
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body"), timeline = find(root, "timeline");
    if (!this.insights) {
      this.insights = { space: space?.id, back: current, panel: panel && !panel.hidden ? body?.active ?? null : null,
        timeline: Boolean(timeline && !timeline.hidden), focus: this.focus };
    }
    if (timeline && !timeline.hidden) {
      run("layout.hide", { id: "timeline" });
      this.timelineShown = false;
      this.timelineWant = { shown: false, until: Date.now() + 1000 };
      this.focus = null; // kept in this.insights.focus; the Timeline isn't closing for good
    }
    if (panel && !panel.hidden) run("layout.hide", { id: "panel" });
    if (pane) run("pane.focus", { pane: pane.pane });
    else run("tab.new", { name: "Insights", mod: "insights" });
  }

  closeInsights() {
    const { pane } = this.insightsPane();
    if (pane) run("tab.close", { id: pane.tab, confirmed: true });
    this.restoreInsights(true);
  }

  restoreInsights(goBack) {
    const was = this.insights;
    if (!was) return;
    this.insights = null;
    const space = spaces().find((s) => s.active);
    if (goBack && was.back && space?.id === was.space && space.tabs.some((t) => t.id === was.back)) run("tab.select", { id: was.back });
    if (was.timeline) {
      this.focus = was.focus;
      this.saveFocus();
      run("layout.show", { id: "timeline" });
      this.timelineShown = true;
      this.timelineWant = { shown: true, until: Date.now() + 1000 };
    } else if (was.panel) {
      run("layout.select", { stack: "panel-body", child: was.panel });
      run("layout.show", { id: "panel" });
    }
  }

  // The Timeline button and cmd-shift-b: the panel and the Timeline change in the same
  // step, so the layout reflows once (no frame with both, or neither, showing).
  toggleTimeline() {
    const root = layout(), timeline = find(root, "timeline"), panel = find(root, "panel");
    if (!timeline) return;
    const open = Boolean(timeline.hidden);
    if (open) {
      if (!this.focus) { this.focus = { panel: Boolean(panel && !panel.hidden) }; this.saveFocus(); }
      if (this.focus.panel) run("layout.hide", { id: "panel" });
      run("layout.show", { id: "timeline" });
    } else {
      const f = this.focus;
      this.focus = null;
      this.saveFocus();
      run("layout.hide", { id: "timeline" });
      if (f?.panel) run("layout.show", { id: "panel" });
    }
    // Until the layout shows it, the old state isn't a change (syncTimeline).
    this.timelineShown = open;
    this.timelineWant = { shown: open, until: Date.now() + 1000 };
  }

  // VNH: opening the Timeline hides the Files/Changes panel; closing it brings the panel
  // back if it was open. The left sidebar is left alone. It follows the timeline block
  // when something else toggles it (the palette); the button and cmd-shift-b use
  // toggleTimeline, which changes both at once. `this.focus` is what
  // was open, kept in localStorage so a reload while the Timeline shows still restores it.
  syncTimeline(timeline, panel) {
    if (!timeline) return;
    const shown = !timeline.hidden;
    if (this.timelineWant) {
      if (this.timelineWant.shown !== shown && Date.now() < this.timelineWant.until) return;
      this.timelineWant = null;
    }
    const was = this.timelineShown;
    this.timelineShown = shown;
    if (shown && was === false && !this.focus) {
      this.focus = { panel: Boolean(panel && !panel.hidden) };
      this.saveFocus();
      if (this.focus.panel) run("layout.hide", { id: "panel" });
    } else if (!shown && this.focus) {
      const f = this.focus;
      this.focus = null;
      this.saveFocus();
      if (f.panel) run("layout.show", { id: "panel" });
    }
  }

  saveFocus() {
    try {
      if (this.focus) localStorage.setItem("timelineFocus", JSON.stringify(this.focus));
      else localStorage.removeItem("timelineFocus");
    } catch {}
  }

  // One tab per wheel notch. A touchpad or smooth-scrolling mouse sends many
  // small events per gesture: a short swipe or one smoothed notch (about
  // 25 px) switches one tab, a longer swipe keeps going a tab per 60 px, at
  // most one every 100 ms so each shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause
    // or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    // While the Timeline hides the panel (syncTimeline), that isn't the space's choice.
    if (!space || !panel || this.focus || this.insights) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    // One snapshot per render (every panes() call copies the whole list into JS), and the sleepers only when a cover exists.
    const allPanes = panes();
    const covers = new Map(allPanes.filter(p => p.mod === "vnh-cover").map(p => [p.tab, p.pane]));
    const sleepers = covers.size ? (shared("vnh.asleep") ?? []) : [];
    const item = (c, i) => {
      const lead = allPanes.find(p => p.tab === c.id && p.program?.agent) ?? allPanes.find(p => p.tab === c.id);
      const program = lead?.program;
      // VNH: a tab whose agent sleeps (a vnh-cover pane in it, see vnh-agents/sleep.js) keeps the title it had; its
      // icon is a moon and all its text is gray.
      const nap = covers.has(c.id) ? sleepers.find(r => r.cover === covers.get(c.id) || r.tab === c.id) ?? null : null;
      const name = nap?.title ? nap.title : label(c, lead);
      // VNH: the preview of a conversation (vnh-convo, opened from the Timeline) is marked: an eye, the accent colour, a PREVIEW pill, the
      // title in italics: a glance tells it from the tabs that run something.
      const preview = allPanes.some(p => p.tab === c.id && p.mod === "vnh-convo");
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(preview ? t.accent + (c.active ? "99" : "55") : c.active ? t.border : t.chrome).bg(preview ? t.accent + (c.active ? "26" : "14") : c.active ? t.raised : t.chrome).text_color(nap ? t.dim : c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        // VNH: while an agent in this tab works its icon breathes (the same slow opacity loop as the space tiles).
        .when(Boolean(nap), el => el.child(svg("mods/vnh-agents/moon.svg").size(14).text_color(t.dim)))
        .when(preview, el => el.child(svg("mods/vnh-tabs/eye.svg").size(14).text_color(t.accent)))
        .when(Boolean(program?.icon) && !nap && !preview, el => {
          const icon = program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14);
          return el.child(c.working_since != null ? icon.loop("opacity", { from: 0.35, to: 1, period: 1800 }) : icon);
        })
        .when(preview, el => el.child(div().flex_none().px(5).h(15).flex().items_center().rounded(4).bg(t.accent + "33").text_size(9).font_semibold().text_color(t.accent).child("PREVIEW")))
        .child(div().max_w(preview ? 140 : 170).truncate().when(preview, el => el.italic()).child(c.zoomed ? `${name} Z` : name))
        // VNH: no working spinner here; the Agents list in the sidebar is the one that shows it.
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // VNH: the git-graph panel shows when the layout's panel holds it (Herdr's panel settings don't know it).
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), ...(body?.children?.some(c => c.id === "graph") ? ["graph"] : [])];
    if (this.insights && !panes().some((p) => p.mod === "insights")) this.restoreInsights(false);
    this.syncTimeline(find(root, "timeline"), panel);
    this.syncWidths(panel, find(root, "timeline"));
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { this.leaveTimeline(); run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    // VNH: the Timeline panel (over9k-prompts) is its own layout block, toggled like Files/Changes.
    const timeline = find(root, "timeline");
    const timelineButton = () => {
      const on = Boolean(timeline) && !timeline.hidden;
      return h_flex().id("panel-timeline").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => this.toggleTimeline())
        .child(svg("mods/vnh-prompts/timeline.svg").size(14)).child("Timeline");
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scroll().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(enabled.includes("graph"), el => el.child(panelButton("graph", "Git", "mods/git-graph/icons/graph.svg")))
      .when(Boolean(timeline), el => el.child(timelineButton()))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/vnh-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/vnh-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/vnh-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}

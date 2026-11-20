// The branch popup of the VNH sidebar's branch button (vnh-chrome), JetBrains style: a search box,
// the actions (Update Project, Commit, Push, Incoming and Outgoing, New Branch, Checkout Tag or
// Revision), then the Local branches (the current one marked, its upstream on the right) and the
// Remote ones (folded until opened or searched). Type to filter both; ↑/↓, Enter, Esc.
//
// props: { root, on, space }. Git runs on the project's machine with prompts off
// (GIT_TERMINAL_PROMPT=0), never forced; results are toasts. After a change it sets shared
// "vnh.git.changed" so the sidebar's branch button reads the branch again at once.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, props, closeOverlay, exec, run, notify, setShared } from "herdr";

const ICON = (name) => `mods/vnh-git-menu/${name}.svg`;
const READ_SCRIPT = [
  'cd "$1" || exit 2',
  'echo "@@head"; git symbolic-ref -q --short HEAD || git rev-parse --short HEAD',
  'echo "@@up"; git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null',
  'echo "@@counts"; git rev-list --left-right --count "HEAD...@{u}" 2>/dev/null',
  "echo \"@@local\"; git for-each-ref --sort=-committerdate --format='%(refname:short)%09%(upstream:short)' refs/heads",
  "echo \"@@remote\"; git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/remotes",
].join("\n");

function sections(text) {
  const out = {};
  let key = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) { key = line.slice(2); out[key] = []; continue; }
    if (key && line.trim()) out[key].push(line);
  }
  return out;
}

export default class GitMenu extends View {
  init(_props, cx) {
    this.query = ""; this.at = 0; this.mode = null; // null | "branch" | "revision"
    this.remoteOpen = false; this.localOpen = true;
    this.data = null; this.busy = false;
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search branches and actions" });
    this.input.on("change", (_e, cx) => { if (!this.mode) { this.query = this.input.value(); this.at = 0; } cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.focus();
    cx.timer.after(250, () => this.input.focus());
    this.load(cx);
  }

  get p() { return props() ?? {}; }
  close() { closeOverlay(this.p.overlay); }

  git(args, extra = {}) {
    return exec("env", ["GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=0", "git", ...args], { cwd: this.p.root, on: this.p.on ?? null, timeout: 120000, ...extra });
  }

  load(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", READ_SCRIPT, "read", this.p.root], { on: this.p.on ?? null, timeout: 15000 }).catch(() => null);
      const s = sections(r?.stdout ?? "");
      const [ahead, behind] = (s.counts?.[0] ?? "").trim().split(/\s+/).map(Number);
      const local = (s.local ?? []).map((l) => { const [name, up] = l.split("\t"); return { name, up: up || null }; });
      const tracked = new Set(local.map((b) => b.up).filter(Boolean)), names = new Set(local.map((b) => b.name));
      const remote = (s.remote ?? []).map((l) => l.trim()).filter((n) => n && !/\/HEAD$/.test(n) && n.includes("/"))
        .map((name) => ({ name, tracked: tracked.has(name) || names.has(name.replace(/^[^/]+\//, "")) }));
      this.data = { head: (s.head?.[0] ?? "").trim(), up: (s.up?.[0] ?? "").trim() || null, ahead: ahead || 0, behind: behind || 0, local, remote };
      cx.notify();
    });
  }

  changed() { setShared("vnh.git.changed", Date.now()); }

  // A git command in the background: the popup closes, a toast says how it went.
  act(title, args, done) {
    this.close();
    notify({ title: `${title}…`, level: "info", timeout: 2500 });
    this.git(args).then((r) => {
      const err = (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).pop() ?? "";
      if (r.code === 0) notify({ title: done, level: "success", timeout: 3500 });
      else notify({ title: `${title} failed`, body: err || `git exited ${r.code}`, level: "error", timeout: 8000 });
      this.changed();
    }).catch((e) => notify({ title: `${title} failed`, body: String(e?.message ?? e), level: "error", timeout: 8000 }));
  }

  actions() {
    const d = this.data, sync = d?.up ? `↓${d.behind} ↑${d.ahead}` : "no upstream";
    return [
      { id: "update", icon: "update", label: "Update Project…", hint: d?.up ? `pull ${d.up}` : "", run: () => this.act("Updating", ["pull", "--ff-only"], `Updated ${d?.head ?? ""}`) },
      { id: "commit", icon: "commit", label: "Commit…", hint: "Changes", run: () => { this.close(); run("layout.select", { stack: "panel-body", child: "changes" }); run("layout.show", { id: "panel" }); } },
      { id: "push", icon: "push", label: "Push…", hint: "⌘\\", run: () => { this.close(); run("vnh-tabs.git-push"); } },
      { id: "io", icon: "clock", label: "Incoming and Outgoing Commits…", hint: sync, run: () => this.act("Fetching", ["fetch", "--quiet", "--prune"], "Fetched: the counts are up to date") },
      { id: "new", icon: "plus", label: "New Branch…", hint: `from ${d?.head ?? "HEAD"}`, divider: true, run: (cx) => this.ask("branch", cx) },
      { id: "rev", icon: "tag", label: "Checkout Tag or Revision…", hint: "", run: (cx) => this.ask("revision", cx) },
    ];
  }

  ask(mode, cx) {
    this.mode = mode;
    this.input.set_value("");
    this.input.focus();
    cx.notify();
  }

  submit(cx) {
    if (this.mode) {
      const v = this.input.value().trim();
      if (!v) return;
      if (/\s/.test(v) || v.startsWith("-")) { notify({ title: "Invalid name", body: v, level: "warning", timeout: 3000 }); return; }
      if (this.mode === "branch") this.act("Creating branch", ["switch", "-c", v], `On the new branch ${v}`);
      else this.act("Checking out", ["checkout", v], `Checked out ${v}`);
      return;
    }
    const item = this.items().filter((x) => x.select)[this.at];
    if (item) item.select(cx);
  }

  checkout(b) {
    if (b.kind === "local") { if (b.name !== this.data?.head) this.act("Checking out", ["switch", b.name], `On ${b.name}`); else this.close(); }
    else this.act("Checking out", ["switch", "--track", b.name], `On ${b.name.replace(/^[^/]+\//, "")}, tracking ${b.name}`);
  }

  // Everything the list shows, in order; rows with `select` take the keyboard.
  items() {
    const q = this.query.trim().toLowerCase(), has = (text) => !q || text.toLowerCase().includes(q);
    const out = [];
    const acts = this.actions().filter((a) => has(a.label));
    for (const a of acts) out.push({ kind: "action", ...a, select: (cx) => a.run(cx) });
    const d = this.data;
    if (!d) return [...out, { kind: "note", text: "Reading branches…" }];
    const local = d.local.filter((b) => has(b.name));
    if (local.length) {
      out.push({ kind: "group", key: "local", label: "Local", open: this.localOpen || Boolean(q), divider: acts.length > 0 });
      if (this.localOpen || q) for (const b of local) out.push({ kind: "branch", b: { ...b, kind: "local" }, select: () => this.checkout({ ...b, kind: "local" }) });
    }
    const remote = d.remote.filter((b) => has(b.name));
    if (remote.length) {
      out.push({ kind: "group", key: "remote", label: "Remote", open: this.remoteOpen || Boolean(q), divider: !local.length && acts.length > 0 });
      if (this.remoteOpen || q) for (const b of remote) out.push({ kind: "branch", b: { ...b, kind: "remote" }, select: () => this.checkout({ ...b, kind: "remote" }) });
    }
    if (!out.some((x) => x.select)) out.push({ kind: "note", text: "Nothing matches" });
    return out;
  }

  row(it, i, sel, t) {
    if (it.kind === "note") return div().px(12).py(8).text_size(12).text_color(t.dim).child(it.text);
    if (it.kind === "group") {
      return h_flex().id(`g-${it.key}`).h(28).flex_none().px(10).gap(6).items_center().cursor_pointer().text_color(t.muted)
        .when(Boolean(it.divider), (el) => el.mt(4).border_t(1).border_color(t.border))
        .on_click((_e, cx) => { if (it.key === "local") this.localOpen = !this.localOpen; else this.remoteOpen = !this.remoteOpen; cx.notify(); })
        .child(svg(ICON(it.open ? "chevron-down" : "chevron-right")).size(12).flex_none())
        .child(div().text_size(12.5).child(it.label));
    }
    const on = i === sel;
    const base = h_flex().id(`r-${i}-${it.id ?? it.b?.name}`).h(30).flex_none().px(10).gap(9).items_center().rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(t.accent + "40")).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => it.select(cx));
    if (it.kind === "action") {
      return div().when(Boolean(it.divider), (el) => el.mt(4).pt(4).border_t(1).border_color(t.border)).child(base
        .child(svg(ICON(it.icon)).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(it.label))
        .when(Boolean(it.hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(it.hint))));
    }
    const b = it.b, here = b.kind === "local" && b.name === this.data?.head;
    return base.pl(26)
      .child(svg(ICON(b.kind === "local" ? (here ? "tag" : "branch") : "cloud")).size(13).flex_none().text_color(here ? t.ansi3 : t.muted))
      .child(div().flex_none().max_w(220).truncate().text_color(t.foreground).child(b.name))
      .when(here, (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(4).bg(t.accent + "33").text_size(10.5).text_color(t.accent).child("current")))
      .child(div().flex_1())
      .when(Boolean(b.up), (el) => el.child(div().flex_none().max_w(150).truncate().text_size(11).text_color(t.dim).child(b.up)));
  }

  render() {
    const t = theme(), items = this.items(), selectable = items.filter((x) => x.select);
    if (this.at >= selectable.length) this.at = Math.max(0, selectable.length - 1);
    const sel = items.indexOf(selectable[this.at]);
    const prompt = this.mode === "branch" ? "New branch name" : this.mode === "revision" ? "Tag, branch or commit to check out" : null;
    const listH = Math.min(440, Math.max(60, items.reduce((h, x) => h + (x.kind === "note" ? 34 : x.kind === "group" ? 32 : x.divider ? 39 : 31), 8)));
    return v_flex().id("git-menu").track_focus(this.handle).w_full().bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") { cx.stop_propagation(); if (this.mode) { this.mode = null; this.input.set_value(this.query); cx.notify(); } else this.close(); return; }
        if (this.mode || !selectable.length) return;
        if (k === "down") this.at = (this.at + 1) % selectable.length;
        else if (k === "up") this.at = (this.at + selectable.length - 1) % selectable.length;
        else return;
        this.scroll.scroll_to_item(items.indexOf(selectable[this.at]));
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(ICON(prompt ? (this.mode === "branch" ? "plus" : "tag") : "search")).size(14).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
        .when(Boolean(prompt), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("Enter · Esc"))))
      .when(Boolean(prompt), (el) => el.child(div().px(12).py(8).text_size(12).text_color(t.muted).child(prompt)))
      .when(!prompt, (el) => el.child(v_flex().id("git-menu-rows").h(listH).flex_none().p(4).gap(1).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(items.map((it, i) => this.row(it, i, sel, t)))));
  }
}

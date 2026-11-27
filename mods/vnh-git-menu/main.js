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
import { theme, props, closeOverlay, exec, run, notify, shared, setShared } from "herdr";

const ICON = (name) => `mods/vnh-git-menu/${name}.svg`;
const SEC = "@@{sec}:";
const READ_SCRIPT = [
  'cd -- "$1" || exit 2',
  `echo "${SEC}head"; git symbolic-ref -q --short HEAD || git rev-parse --short HEAD`,
  `echo "${SEC}up"; git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null`,
  `echo "${SEC}counts"; git rev-list --left-right --count "HEAD...@{u}" 2>/dev/null`,
  `echo "${SEC}local"; git for-each-ref --sort=-committerdate --format='%(refname:short)%09%(upstream:short)' refs/heads`,
  `echo "${SEC}remote"; git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/remotes`,
].join("\n");

function sections(text) {
  const out = {};
  let key = null;
  for (const line of text.split("\n")) {
    if (line.startsWith(SEC)) { key = line.slice(SEC.length); out[key] = []; continue; }
    if (key && line.trim()) out[key].push(line);
  }
  return out;
}

export default class GitMenu extends View {
  init(_props, cx) {
    this.query = ""; this.at = 0; this.mode = null; // null | "branch" | "revision" | "from" | "rename"
    this.sub = null;   // the branch whose actions show under it: "local:name" | "remote:name"
    this.target = null; // the branch a "from" / "rename" prompt is about
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

  // Favorite branches per repository (shared "vnh.git.favorites"): a star, and first in Local.
  favorites() { return new Set((shared("vnh.git.favorites") ?? {})[this.p.root] ?? []); }
  toggleFavorite(name, cx) {
    const all = shared("vnh.git.favorites") ?? {}, set = new Set(all[this.p.root] ?? []);
    if (set.has(name)) set.delete(name); else set.add(name);
    setShared("vnh.git.favorites", { ...all, [this.p.root]: [...set] });
    cx.notify();
  }

  // A branch's history in a new tab of this space: git log as a graph, through the pager.
  history(name) {
    this.close();
    run("tab.new", { space: this.p.space ?? undefined, folder: this.p.root, name: `history: ${name}`,
      argv: ["sh", "-c", 'git log --graph --decorate --color=always --format="%C(auto)%h %d %s %C(dim)%an, %ar" "$1" -- | less -R', "history", name] });
  }

  // The actions under a branch (its › or →), as JetBrains lists them.
  branchActions(b) {
    const head = this.data?.head, here = b.kind === "local" && b.name === head;
    const remoteOf = (up) => (up ? up.split("/")[0] : null);
    if (b.kind === "remote") {
      return [
        { id: "co", icon: "branch", label: "Checkout", run: () => this.checkout(b) },
        { id: "from", icon: "plus", label: `New Branch from '${b.name}'…`, run: (cx) => this.ask("from", cx, b) },
        { id: "hist", icon: "clock", label: "Show History", run: () => this.history(b.name) },
      ];
    }
    const fav = this.favorites().has(b.name), up = b.up, remote = remoteOf(up);
    return [
      { id: "from", icon: "branch", label: `New Branch from '${b.name}'…`, run: (cx) => this.ask("from", cx, b) },
      { id: "update", icon: "update", label: "Update", divider: true,
        run: () => here ? this.act("Updating", ["pull", "--ff-only"], `Updated ${b.name}`)
          : up ? this.act("Updating", ["fetch", remote, `${up.slice(remote.length + 1)}:${b.name}`], `Updated ${b.name} from ${up}`)
          : notify({ title: `${b.name} has no upstream`, body: "Push it once to set one.", level: "warning", timeout: 4000 }) },
      { id: "push", icon: "push", label: "Push…",
        run: () => { if (here) { this.close(); run("vnh-tabs.git-push"); } else this.pushBranch(b); } },
      { id: "rename", icon: "rename", label: "Rename…", divider: true, run: (cx) => this.ask("rename", cx, b) },
      { id: "fav", icon: "star", label: fav ? "Remove from Favorites" : "Add to Favorites", run: (cx) => this.toggleFavorite(b.name, cx) },
      { id: "hist", icon: "clock", label: "Show History", run: () => this.history(b.name) },
    ];
  }

  // Another branch than the current one: to its upstream, else origin (or the first remote) with
  // --set-upstream; then the tags. Never forced.
  pushBranch(b) {
    this.close();
    notify({ title: `Pushing ${b.name}…`, level: "info", timeout: 2500 });
    const script = [
      'up=$(git rev-parse --abbrev-ref --symbolic-full-name "$1@{u}" 2>/dev/null)',
      'if [ -n "$up" ]; then r=${up%%/*}; git push --quiet "$r" "$1:${up#*/}" || exit 4',
      'else r=$(git remote | grep -x origin || git remote | head -n 1); [ -n "$r" ] || { echo "This repository has no remote" >&2; exit 5; }',
      '  git push --quiet --set-upstream "$r" "$1" || exit 4; fi',
      'git push --quiet "$r" --tags || exit 6',
      'echo "$r"',
    ].join("\n");
    exec("env", ["GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=0", "sh", "-c", script, "push", b.name], { cwd: this.p.root, on: this.p.on ?? null, timeout: 120000 })
      .then((r) => {
        const err = (r.stderr ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
        if (r.code === 0) notify({ title: `Pushed ${b.name} and tags to ${(r.stdout ?? "").trim()}`, level: "success", timeout: 4000 });
        else if (r.code === 6) notify({ title: `Pushed ${b.name}; tags were refused`, body: err, level: "warning", timeout: 8000 });
        else notify({ title: "Push failed", body: err || `git exited ${r.code}`, level: "error", timeout: 8000 });
        this.changed();
      })
      .catch((e) => notify({ title: "Push failed", body: String(e?.message ?? e), level: "error", timeout: 8000 }));
  }

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
      { id: "push", icon: "push", label: "Push…", run: () => { this.close(); run("vnh-tabs.git-push"); } },
      { id: "io", icon: "clock", label: "Incoming and Outgoing Commits…", hint: sync, run: () => this.act("Fetching", ["fetch", "--quiet", "--prune"], "Fetched: the counts are up to date") },
      { id: "new", icon: "plus", label: "New Branch…", hint: `from ${d?.head ?? "HEAD"}`, divider: true, run: (cx) => this.ask("branch", cx) },
      { id: "rev", icon: "tag", label: "Checkout Tag or Revision…", hint: "", run: (cx) => this.ask("revision", cx) },
    ];
  }

  ask(mode, cx, target = null) {
    this.mode = mode; this.target = target;
    this.input.set_value(mode === "rename" && target ? target.name : "");
    this.input.focus();
    cx.notify();
  }

  submit(cx) {
    if (this.mode) {
      const v = this.input.value().trim();
      if (!v) return;
      if (/\s/.test(v) || v.startsWith("-")) { notify({ title: "Invalid name", body: v, level: "warning", timeout: 3000 }); return; }
      if (this.mode === "branch") this.act("Creating branch", ["switch", "-c", v], `On the new branch ${v}`);
      else if (this.mode === "from") this.act("Creating branch", ["switch", "-c", v, this.target.name], `On the new branch ${v}, from ${this.target.name}`);
      else if (this.mode === "rename") { if (v !== this.target.name) this.act("Renaming", ["branch", "-m", this.target.name, v], `Renamed ${this.target.name} to ${v}`); else this.close(); }
      else this.act("Checking out", ["checkout", v, "--"], `Checked out ${v}`);
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
    const favs = this.favorites();
    const local = d.local.filter((b) => has(b.name)).sort((a, b) => Number(favs.has(b.name)) - Number(favs.has(a.name)));
    const subsOf = (b) => (this.sub === `${b.kind}:${b.name}` ? this.branchActions(b).map((a) => ({ kind: "sub", ...a, select: (cx) => a.run(cx) })) : []);
    if (local.length) {
      out.push({ kind: "group", key: "local", label: "Local", open: this.localOpen || Boolean(q), divider: acts.length > 0 });
      if (this.localOpen || q) for (const b0 of local) { const b = { ...b0, kind: "local", fav: favs.has(b0.name) }; out.push({ kind: "branch", b, select: () => this.checkout(b) }, ...subsOf(b)); }
    }
    const remote = d.remote.filter((b) => has(b.name));
    if (remote.length) {
      out.push({ kind: "group", key: "remote", label: "Remote", open: this.remoteOpen || Boolean(q), divider: !local.length && acts.length > 0 });
      if (this.remoteOpen || q) for (const b0 of remote) { const b = { ...b0, kind: "remote" }; out.push({ kind: "branch", b, select: () => this.checkout(b) }, ...subsOf(b)); }
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
    if (it.kind === "sub") {
      return div().when(Boolean(it.divider), (el) => el.mt(2).pt(2).border_t(1).border_color(t.border)).child(base.pl(44).bg(on ? t.accent + "40" : t.raised)
        .child(svg(ICON(it.icon)).size(13).flex_none().text_color(it.icon === "star" ? t.ansi3 : t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(it.label)));
    }
    if (it.kind === "action") {
      return div().when(Boolean(it.divider), (el) => el.mt(4).pt(4).border_t(1).border_color(t.border)).child(base
        .child(svg(ICON(it.icon)).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(it.label))
        .when(Boolean(it.hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(it.hint))));
    }
    const b = it.b, here = b.kind === "local" && b.name === this.data?.head, key = `${b.kind}:${b.name}`, open = this.sub === key;
    return base.pl(26)
      .child(svg(ICON(b.fav ? "star" : b.kind === "local" ? (here ? "tag" : "branch") : "cloud")).size(13).flex_none().text_color(here || b.fav ? t.ansi3 : t.muted))
      .child(div().flex_none().max_w(220).truncate().text_color(t.foreground).child(b.name))
      .when(here, (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(4).bg(t.accent + "33").text_size(10.5).text_color(t.accent).child("current")))
      .child(div().flex_1())
      .when(Boolean(b.up), (el) => el.child(div().flex_none().max_w(150).truncate().text_size(11).text_color(t.dim).child(b.up)))
      // VNH: its actions (New Branch from…, Update, Push…, Rename…, Favorites, Show History).
      .child(div().id(`more-${key}`).size(20).flex_none().flex().items_center().justify_center().rounded(4)
        .text_color(open ? t.foreground : t.dim).hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip("Branch actions (→)")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.sub = open ? null : key; cx.notify(); })
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12)));
  }

  render() {
    const t = theme(), items = this.items(), selectable = items.filter((x) => x.select);
    if (this.at >= selectable.length) this.at = Math.max(0, selectable.length - 1);
    const sel = items.indexOf(selectable[this.at]);
    const prompt = this.mode === "branch" ? "New branch name"
      : this.mode === "from" ? `New branch from '${this.target?.name}'`
      : this.mode === "rename" ? `Rename '${this.target?.name}' to`
      : this.mode === "revision" ? "Tag, branch or commit to check out" : null;
    const listH = Math.min(440, Math.max(60, items.reduce((h, x) => h + (x.kind === "note" ? 34 : x.kind === "group" ? 32 : x.divider ? (x.kind === "sub" ? 35 : 39) : 31), 8)));
    return v_flex().id("git-menu").track_focus(this.handle).w_full().bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") { cx.stop_propagation(); if (this.mode) { this.mode = null; this.input.set_value(this.query); cx.notify(); } else this.close(); return; }
        if (this.mode || !selectable.length) return;
        const cur = selectable[this.at];
        if ((k === "right" || k === "left") && cur?.kind === "branch") {
          const key = `${cur.b.kind}:${cur.b.name}`;
          this.sub = k === "right" ? key : this.sub === key ? null : this.sub;
          cx.stop_propagation(); cx.notify(); return;
        }
        if (k === "left" && cur?.kind === "sub") { this.sub = null; cx.stop_propagation(); cx.notify(); return; }
        if (k === "down") this.at = (this.at + 1) % selectable.length;
        else if (k === "up") this.at = (this.at + selectable.length - 1) % selectable.length;
        else return;
        this.scroll.scroll_to_item(items.indexOf(selectable[this.at]));
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(ICON(prompt ? ({ branch: "plus", from: "branch", rename: "rename" }[this.mode] ?? "tag") : "search")).size(14).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
        .when(Boolean(prompt), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("Enter · Esc"))))
      .when(Boolean(prompt), (el) => el.child(div().px(12).py(8).text_size(12).text_color(t.muted).child(prompt)))
      .when(!prompt, (el) => el.child(v_flex().id("git-menu-rows").h(listH).flex_none().p(4).gap(1).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(items.map((it, i) => this.row(it, i, sel, t)))));
  }
}

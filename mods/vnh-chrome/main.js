import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, spaces, panes, focused, exec, readTextFile, openOverlay, checking } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// ---- The branch button: the repo of the focused work folder (JetBrains style) ----

// The folder the focused work happens in. A mod pane (the Markdown viewer, …) has none, and a
// space's starting folder can be another project: fall back to the last terminal folder focused
// in this space (shared "vnh.lastCwd", kept by vnh-files), then the space's first terminal, then
// its starting folder.
function workFolder(space, f) {
  if (!space) return null;
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane?.terminal && pane.cwd) return pane.cwd;
  if (f && f.pane === null && f.terminal && f.cwd) return f.cwd; // a layout terminal block
  const last = (shared("vnh.lastCwd") ?? {})[space.id];
  if (last) return last;
  const tabs = new Set(space.tabs.map((t) => t.id)), active = space.tabs.find((t) => t.active)?.id;
  const terms = panes().filter((p) => p.terminal && p.cwd && tabs.has(p.tab));
  return (terms.find((p) => p.tab === active) ?? terms[0])?.cwd ?? space.folder ?? null;
}

function runTarget() {
  const space = spaces().find((s) => s.active), f = focused();
  if (!space) return null;
  const cwd = workFolder(space, f);
  return cwd ? { cwd, on: space.machine ?? null, space: space.id } : null;
}

// VNH: the branch button. One read: the repo's top and its branch (or the short hash when detached).
const BRANCH_SCRIPT = 'top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || exit 0; echo "$top"; git -C "$1" symbolic-ref -q --short HEAD || git -C "$1" rev-parse --short HEAD';

// VNH: a trackpad pinch over this bar runs git: spreading out (zoom in) pulls, pinching in (zoom
// out) pushes the branch and its tags (vnh-tabs.git-pull / git-push, on the work folder's repo).
// One action per gesture, only past a clear threshold, at most every 3 s.
function pinchGit(state, e) {
  if (e.touch_phase === "started") { state.sum = 0; return; }
  if (e.touch_phase === "moved") { state.sum = (state.sum ?? 0) + (e.delta ?? 0); return; }
  if (e.touch_phase !== "ended") { state.sum = 0; return; }
  const sum = (state.sum ?? 0) + (e.delta ?? 0);
  state.sum = 0;
  if (Date.now() - (state.at ?? 0) < 3000) return;
  if (sum >= 0.35) { state.at = Date.now(); run("vnh-tabs.git-pull"); }
  else if (sum <= -0.3) { state.at = Date.now(); run("vnh-tabs.git-push"); }
}

export default class WorkspaceChrome extends View {
  init(_props, cx) {
    this.repo = null; // { key, root, on, space, branch }
    if (checking() || props()?.footer) return;
    this.loadBranch(cx);
    // Follow focus quickly; re-read every 10 s while the window is active, and at once after a git
    // action from the branch popup (shared "vnh.git.changed").
    cx.timer.every(1500, (cx) => this.loadBranch(cx));
  }

  loadBranch(cx) {
    const target = runTarget();
    const key = target ? `${target.on ?? ""}:${target.cwd}` : null;
    const changed = (shared("vnh.git.changed") ?? 0) > (this.loadedAt ?? 0);
    const moved = key !== this.loadedKey;
    if (this.loading || (!moved && !changed && (!window()?.active || Date.now() - (this.loadedAt ?? 0) < 10000))) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      let repo = null;
      try {
        if (target) {
          const b = await exec("sh", ["-c", BRANCH_SCRIPT, "branch", target.cwd], { on: target.on, timeout: 10000 }).catch(() => null);
          const [root, branch] = (b?.stdout ?? "").split("\n").map((x) => x.trim());
          if (root) repo = { root, on: target.on, space: target.space, branch: branch || "HEAD" };
        }
      } finally {
        this.loadedKey = key;
        this.loadedAt = Date.now();
        this.loading = false;
        if (JSON.stringify(repo) !== JSON.stringify(this.repo)) { this.repo = repo; cx.notify(); }
      }
    });
  }

  // [⑂ main ▾]: the branch popup (vnh-git-menu), flush with the button's left edge, just below it.
  branchBar(t) {
    const r = this.repo;
    if (!r) return div().flex_1();
    return h_flex().flex_1().min_w(0).items_center()
      .child(h_flex().id("git-branch").min_w(0).h(28).px(8).gap(6).items_center().rounded(7).cursor_pointer()
        .bg(t.hover).hover((s) => s.bg(t.selected)).tooltip(r.root)
        .on_mouse_down("left", (e, cx) => { if (e.bounds) this.pillBounds = e.bounds; cx.stop_propagation(); })
        .on_click(() => {
          const b = this.pillBounds;
          openOverlay({ mod: "vnh-git-menu", kind: "popup", width: 440, height: 560, props: { root: r.root, on: r.on, space: r.space },
            ...(b ? { at: { x: b.x, y: b.y + b.height + 4 } } : {}) });
        })
        .child(svg("mods/vnh-git-menu/branch.svg").size(14).flex_none().text_color(t.muted))
        .child(div().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(r.branch))
        .child(svg("mods/vnh-chrome/chevron-down.svg").size(12).flex_none().text_color(t.muted)));
  }

  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
        .when(collapsed, el => el.relative().w(32).px(0).justify_center().tooltip(label))
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/vnh-chrome/${icon}.svg`).size(14))
        .when(!collapsed, el => el.child(label));
      const ready = div().size(6).rounded_full().bg(t.accent);
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
        .when(collapsed, el => el.px(0).items_center())
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready)))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
    }
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .on_pinch((e) => pinchGit(this.pinch ??= {}, e))
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      // VNH: the branch button replaces the logo, search (⌘P) and the sidebar toggle (⌘B).
      .when(!collapsed, el => el.child(this.branchBar(t)))
      // On the non-mac rail keep the toggle so the narrow sidebar can be widened by mouse.
      .when(collapsed && window()?.platform !== "macos", el => el.child(this.button("sidebar-toggle", svg("mods/vnh-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}

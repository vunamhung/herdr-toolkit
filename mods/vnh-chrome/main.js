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

// ---- Run configurations: the project's package.json scripts (JetBrains style) ----

// Where the bar reads scripts from: the focused terminal's folder in the active space.
function runTarget() {
  const space = spaces().find((s) => s.active), f = focused();
  if (!space) return null;
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const cwd = pane?.cwd || f?.cwd || space.folder;
  return cwd ? { cwd, on: space.machine ?? null, space: space.id } : null;
}

// The project's package.json: at the repo root, else the nearest one above the folder (inside the
// repo). Package manager from "packageManager", else the lock file, else npm.
const PM_SCRIPT = 'top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null); d=$1; found=; if [ -n "$top" ] && [ -f "$top/package.json" ]; then found=$top; else while :; do [ -f "$d/package.json" ] && { found=$d; break; }; [ -n "$top" ] && [ "$d" = "$top" ] && break; p=$(dirname "$d"); [ "$p" = "$d" ] && break; [ -z "$top" ] && [ "$d" = "$HOME" ] && break; d=$p; done; fi; [ -n "$found" ] || exit 0; echo "$found"; for f in pnpm-lock.yaml yarn.lock bun.lockb bun.lock package-lock.json; do [ -e "$found/$f" ] && { echo "$f"; break; }; done; true';
const LOCK_PM = { "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "bun.lockb": "bun", "bun.lock": "bun", "package-lock.json": "npm" };

export function selectedScript(root, scripts) {
  const chosen = (shared("vnh.run.selected") ?? {})[root];
  if (chosen && scripts.some((x) => x.name === chosen)) return chosen;
  return scripts.find((x) => x.name === "dev")?.name ?? scripts[0]?.name ?? null;
}

export function runScript(project, name) {
  if (!project || !name) return;
  run("tab.new", { space: project.space, folder: project.root, name: `${project.pm} run ${name}`, argv: [project.pm, "run", name] });
}

export default class WorkspaceChrome extends View {
  init(_props, cx) {
    this.project = null; // { key, root, on, space, pm, scripts: [{ name, cmd }] }
    if (checking() || props()?.footer) return;
    this.loadProject(cx);
    // Follow focus changes quickly; re-read package.json every 10 s, only while the window is active.
    cx.timer.every(1500, (cx) => this.loadProject(cx));
  }

  loadProject(cx) {
    const target = runTarget();
    const key = target ? `${target.on ?? ""}:${target.cwd}` : null;
    const moved = key !== this.loadedKey;
    if (this.loading || (!moved && (!window()?.active || Date.now() - (this.loadedAt ?? 0) < 10000))) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      let project = null;
      try {
        if (target) {
          const r = await exec("sh", ["-c", PM_SCRIPT, "pm", target.cwd], { on: target.on, timeout: 10000 }).catch(() => null);
          const [root, lock] = (r?.stdout ?? "").split("\n").map((x) => x.trim());
          if (root) {
            const text = await readTextFile(`${root}/package.json`, { on: target.on }).catch(() => null);
            let pkg = null;
            try { pkg = text ? JSON.parse(text) : null; } catch { pkg = null; }
            const scripts = Object.entries(pkg?.scripts ?? {}).filter(([, v]) => typeof v === "string").map(([name, cmd]) => ({ name, cmd }));
            const declared = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
            const pm = ["pnpm", "yarn", "bun", "npm"].includes(declared) ? declared : LOCK_PM[lock] ?? "npm";
            if (scripts.length) project = { root, on: target.on, space: target.space, pm, scripts };
          }
        }
      } finally {
        this.loadedKey = key;
        this.loadedAt = Date.now();
        this.loading = false;
        if (JSON.stringify(project) !== JSON.stringify(this.project)) { this.project = project; cx.notify(); }
      }
    });
  }

  // [📦 pnpm run dev ▾] [▶]: the pill opens the configurations popup, ▶ runs the selection.
  runBar(t) {
    const p = this.project;
    if (!p) return div().flex_1();
    const name = selectedScript(p.root, p.scripts);
    const stop = (_e, cx) => cx.stop_propagation();
    return h_flex().flex_1().min_w(0).gap(4).items_center().justify_end()
      .child(h_flex().id("run-config").min_w(0).h(28).px(8).gap(6).items_center().rounded(7).cursor_pointer()
        .bg(t.hover).hover((s) => s.bg(t.selected)).on_mouse_down("left", stop)
        .tooltip(p.scripts.find((x) => x.name === name)?.cmd ?? "")
        .on_click(() => openOverlay({ mod: "vnh-run-menu", kind: "popup", width: 400, height: 440, props: { project: p, selected: name } }))
        .child(svg("mods/vnh-chrome/package.svg").size(14).flex_none().text_color(t.ansi2))
        .child(div().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(`${p.pm} run ${name}`))
        .child(svg("mods/vnh-chrome/chevron-down.svg").size(12).flex_none().text_color(t.muted)))
      .child(this.button("run-start", svg("mods/vnh-chrome/play.svg").size(14).text_color(t.ansi2), () => runScript(p, name)).tooltip(`Run ${p.pm} run ${name}`));
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
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      // VNH: the run-configuration bar replaces the logo, search (⌘P) and the sidebar toggle (⌘B).
      .when(!collapsed, el => el.child(this.runBar(t)))
      // On the non-mac rail keep the toggle so the narrow sidebar can be widened by mouse.
      .when(collapsed && window()?.platform !== "macos", el => el.child(this.button("sidebar-toggle", svg("mods/vnh-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}

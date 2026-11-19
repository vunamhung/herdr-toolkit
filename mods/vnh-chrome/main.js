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

// The project's package.json: only at the repo root (the folder itself outside git); none, nothing.
// Package manager from "packageManager", else the lock file, else npm.
const PM_SCRIPT = 'top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || top=$1; [ -f "$top/package.json" ] || exit 0; echo "$top"; for f in pnpm-lock.yaml yarn.lock bun.lockb bun.lock package-lock.json; do [ -e "$top/$f" ] && { echo "$f"; break; }; done; true';
const LOCK_PM = { "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "bun.lockb": "bun", "bun.lock": "bun", "package-lock.json": "npm" };

export function selectedScript(root, scripts) {
  const chosen = (shared("vnh.run.selected") ?? {})[root];
  if (chosen && scripts.some((x) => x.name === chosen)) return chosen;
  return scripts.find((x) => x.name === "dev")?.name ?? scripts[0]?.name ?? null;
}

// A run writes its pid to ~/.cache/vnh-run/<key>.pid (on the project's machine) and execs the
// package manager, so the pid is the script's. Running = that pid is alive and is this script.
export const runKey = (root, name) => `${root}::${name}`.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-180);
const START_SCRIPT = 'mkdir -p "$HOME/.cache/vnh-run" && echo $$ > "$HOME/.cache/vnh-run/$3.pid" && exec "$1" run "$2"';
const CHECK_SCRIPT = 'f="$HOME/.cache/vnh-run/$1.pid"; [ -f "$f" ] || exit 0; p=$(cat "$f"); kill -0 "$p" 2>/dev/null && ps -p "$p" -o args= | grep -qF -- "$2" && echo "$p"; true';
// Like JetBrains' stop: SIGINT to the script's process group (or its whole process tree), then
// SIGTERM to whatever is still alive after 3 s. The tab and its output stay.
const STOP_SCRIPT = 'f="$HOME/.cache/vnh-run/$1.pid"; [ -f "$f" ] || exit 0; p=$(cat "$f"); tree() { for c in $(pgrep -P "$1"); do tree "$c"; done; echo "$1"; }; pids=$(tree "$p"); kill -INT -- "-$p" 2>/dev/null || kill -INT $pids 2>/dev/null; i=0; while [ $i -lt 30 ]; do alive=; for x in $pids; do kill -0 "$x" 2>/dev/null && alive="$alive $x"; done; [ -z "$alive" ] && exit 0; sleep 0.1; i=$((i+1)); done; kill -TERM $alive 2>/dev/null; true';

export function runScript(project, name) {
  if (!project || !name) return;
  run("tab.new", { space: project.space, folder: project.root, name: `${project.pm} run ${name}`,
    argv: ["sh", "-c", START_SCRIPT, "vnh-run", project.pm, name, runKey(project.root, name)] });
}

export default class WorkspaceChrome extends View {
  init(_props, cx) {
    this.project = null; // { key, root, on, space, pm, scripts: [{ name, cmd }] }
    if (checking() || props()?.footer) return;
    this.running = null; // { key, pid } of the selected script while it runs
    this.loadProject(cx);
    // Follow focus changes quickly; re-read package.json every 10 s, only while the window is active.
    cx.timer.every(1500, (cx) => { this.loadProject(cx); this.checkRunning(cx); });
  }

  // Is the selected script running (started from the bar)? One tiny `sh` per tick while active.
  checkRunning(cx) {
    const p = this.project;
    const name = p ? selectedScript(p.root, p.scripts) : null;
    const key = name ? runKey(p.root, name) : null;
    if (!key) { if (this.running) { this.running = null; cx.notify(); } return; }
    if (this.checking || (!window()?.active && this.running?.key === key)) return;
    this.checking = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", CHECK_SCRIPT, "check", key, `run ${name}`], { on: p.on, timeout: 5000 }).catch(() => null);
        const pid = r?.stdout.trim() || null;
        const next = pid ? { key, pid } : null;
        if (JSON.stringify(next) !== JSON.stringify(this.running)) { this.running = next; cx.notify(); }
      } finally { this.checking = false; }
    });
  }

  stopScript(cx) {
    const p = this.project, key = this.running?.key;
    if (!p || !key) return;
    this.stopping = true; cx.notify();
    cx.spawn(async (cx) => {
      try { await exec("sh", ["-c", STOP_SCRIPT, "stop", key], { on: p.on, timeout: 10000 }).catch(() => null); }
      finally { this.stopping = false; this.running = null; cx.notify(); this.checkRunning(cx); }
    });
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
    const running = Boolean(this.running) && this.running.key === runKey(p.root, name);
    return h_flex().flex_1().min_w(0).gap(4).items_center().justify_end()
      .child(h_flex().id("run-config").min_w(0).h(28).px(8).gap(6).items_center().rounded(7).cursor_pointer()
        .bg(t.hover).hover((s) => s.bg(t.selected))
        // Remember where the pill is, so the popup opens flush with its left edge, just below it.
        .on_mouse_down("left", (e, cx) => { if (e.bounds) this.pillBounds = e.bounds; cx.stop_propagation(); })
        .tooltip(p.scripts.find((x) => x.name === name)?.cmd ?? "")
        .on_click(() => {
          const b = this.pillBounds;
          openOverlay({ mod: "vnh-run-menu", kind: "popup", width: 400, height: 440, props: { project: p, selected: name },
            ...(b ? { at: { x: b.x, y: b.y + b.height + 4 } } : {}) });
        })
        .child(svg("mods/vnh-chrome/package.svg").size(14).flex_none().text_color(t.ansi2))
        .child(div().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(`${p.pm} run ${name}`))
        .child(svg("mods/vnh-chrome/chevron-down.svg").size(12).flex_none().text_color(t.muted)))
      .child(this.button("run-start", svg("mods/vnh-chrome/play.svg").size(14).text_color(t.ansi2), () => runScript(p, name)).tooltip(`Run ${p.pm} run ${name}`))
      .when(running, (el) => el.child(this.button("run-stop", svg("mods/vnh-chrome/stop.svg").size(13).text_color(this.stopping ? t.dim : t.ansi1),
        (_e, cx) => this.stopScript(cx)).tooltip(this.stopping ? "Stopping…" : `Stop ${p.pm} run ${name}`)));
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

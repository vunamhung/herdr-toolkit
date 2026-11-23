// Scripts: the "scripts" of package.json in the project's root folder, as a panel tab. A click on one runs it (the package manager
// whose lock file is there: pnpm, yarn, bun, else npm) as a headless Herdr terminal, and its output shows in a section of this
// panel under the list, a read-only log that follows the end. The sections stack (each job under the one before) and the dividers
// between them drag, so each has the height you give it; a job that ended keeps its output and shows its exit code.
// Stop kills it, Restart runs it again, ✕ removes it. `herdr-app do vnh-scripts.run-<script>` (also stop-, restart-) does the same.
// Cost: while the panel is on screen and a job runs, one `hc ls` and one `hc read` per running job every 1.5 s; nothing otherwise.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_resizable, resizable_panel } from "gpui-base";
import { theme, hc, exec, nextCommand, home, focused, panes, spaces, readTextFile, shared, setShared, window, layout, checking } from "herdr";

const FONT = "PragmataPro";
const JOBS = "vnh.scripts.jobs";
const KEEP = 90;                        // lines of a log kept for drawing
const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).reduce((h, c) => h ?? find(c, id), null));
const MANAGERS = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"]];
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export default class Scripts extends View {
  init(_props, cx) {
    this.root = null; this.cwd = null; this.pm = "npm"; this.pkg = null; this.error = ""; this.busy = false; this.sig = "";
    this.live = {};                     // address -> { state, code, text }
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(2000, (cx) => { if (window()?.active !== false && this.shownNow()) this.refresh(cx); });
    cx.timer.every(1500, (cx) => { if (window()?.active !== false && this.shownNow()) this.poll(cx); });
    // "vnh-scripts.run-<script>", "stop-", "restart-", "remove-": the same as the buttons (for a key binding).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand()).replace(/^vnh-scripts\./, ""), m = c.match(/^(run|stop|restart|remove)-(.+)$/);
        if (!m || !this.root) continue;
        if (m[1] === "run") this.start(m[2], cx); else if (m[1] === "stop") this.stop(m[2], cx); else if (m[1] === "remove") this.remove(m[2], cx); else this.restart(m[2], cx);
      }
    });
  }

  shownNow() {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    return Boolean(panel && !panel.hidden && body?.active === "scripts");
  }

  workCwd() {
    const space = spaces().find((s) => s.active), f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return (pane?.terminal && pane.cwd) || (f?.pane === null && f.terminal ? f.cwd : null) || (space ? shared("vnh.lastCwd")?.[space.id] : null) || null;
  }

  async refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    try {
      const cwd = this.workCwd();
      if (cwd && cwd !== this.cwd) {
        this.cwd = cwd;
        const r = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).catch(() => null);
        const root = r?.code === 0 ? String(r.stdout).trim() : cwd;
        if (root !== this.root) {
          this.root = root; this.pm = "npm";
          const ls = await exec("ls", ["-A", root]).catch(() => null);
          const names = new Set(String(ls?.stdout ?? "").split("\n"));
          this.pm = (MANAGERS.find(([f]) => names.has(f)) ?? [null, "npm"])[1];
        }
      }
      let pkg = null, error = "";
      if (this.root) {
        const text = await readTextFile(`${this.root}/package.json`).catch(() => null);
        if (text == null) error = "No package.json in this folder";
        else { try { pkg = JSON.parse(text); } catch { error = "package.json is not valid JSON"; } }
      } else error = "No folder yet";
      const sig = JSON.stringify([pkg?.name, pkg?.scripts, error, this.pm, this.root]);
      if (sig !== this.sig) { this.sig = sig; this.pkg = pkg; this.error = error; cx.notify(); }
    } finally { this.busy = false; }
  }

  // The jobs of this folder, in the order they were started: { name, addr, cmd }.
  all() { const v = shared(JOBS); return Array.isArray(v) ? v : []; }
  jobs() { return this.all().filter((j) => j.root === this.root); }
  save(fn) { setShared(JOBS, fn(this.all())); }

  // One `hc ls` for the state of every job, and a read of the output of those still running (plus one last read when one ends).
  async poll(cx) {
    const jobs = this.jobs();
    if (!jobs.length || this.polling) return;
    if (!jobs.some((j) => (this.live[j.addr]?.state ?? "running") === "running")) return;
    this.polling = true;
    try {
      const r = await hc(["ls", "--all", "--json"]).catch(() => null);
      let rows = []; try { rows = JSON.parse(r?.stdout ?? "{}").terminals ?? []; } catch {}
      let changed = false;
      for (const j of jobs) {
        const prev = this.live[j.addr], row = rows.find((t) => t.address === j.addr);
        if (prev && prev.state !== "running") continue;
        const gone = !row, ended = row && row.state !== "live";
        let code = null;
        if (ended) { const g = await hc(["get", j.addr, "--json"]).catch(() => null); try { code = JSON.parse(g?.stdout ?? "{}").exit_code ?? null; } catch {} }
        const out = await hc(["read", j.addr, "--lines", "400", "--json"]).catch(() => null);
        let text = prev?.text ?? ""; try { text = JSON.parse(out?.stdout ?? "{}").text ?? text; } catch {}
        const lines = text.replace(ANSI, "").split("\n"); while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        const next = { state: gone || ended ? "exited" : "running", code, text: lines.slice(-KEEP).join("\n") };
        if (!prev || prev.state !== next.state || prev.code !== next.code || prev.text !== next.text) { this.live[j.addr] = next; changed = true; }
      }
      if (changed) cx.notify();
    } finally { this.polling = false; }
  }

  stateOf(name) {
    const j = this.jobs().find((x) => x.name === name);
    return j ? (this.live[j.addr]?.state ?? "running") : "idle";
  }

  async start(name, cx) {
    if (!this.root || this.stateOf(name) === "running") return;
    const root = this.root, old = this.jobs().find((x) => x.name === name);
    if (old) { await hc(["rm", old.addr]).catch(() => {}); delete this.live[old.addr]; }
    const cmd = `${this.pm} run ${name}`;
    const r = await hc(["run", "--bg", "--no-parent", "--outlive-parent", "--label", "vnh.scripts=1", "--cwd", root, "--json", "--", "/bin/zsh", "-lic", cmd]).catch(() => null);
    let addr = null; try { addr = JSON.parse(r?.stdout ?? "{}").address ?? null; } catch {}
    if (!addr) return;
    this.save((all) => [...all.filter((j) => !(j.root === root && j.name === name)), { root, name, addr, cmd }]);
    this.live[addr] = { state: "running", code: null, text: "" };
    cx.notify();
    this.poll(cx);
  }

  async stop(name, cx) {
    const j = this.jobs().find((x) => x.name === name);
    if (!j) return;
    await hc(["kill", j.addr]).catch(() => {});
    this.live[j.addr] = { ...(this.live[j.addr] ?? { text: "" }), state: "running", code: null };   // the next poll reads its end
    this.polling = false; this.poll(cx);
  }

  async restart(name, cx) {
    const j = this.jobs().find((x) => x.name === name);
    if (j && this.stateOf(name) === "running") { await hc(["kill", j.addr]).catch(() => {}); await new Promise((ok) => cx.timer.after(400, () => ok(null))); this.live[j.addr] = { state: "exited", code: null, text: "" }; }
    this.start(name, cx);
  }

  async remove(name, cx) {
    const j = this.jobs().find((x) => x.name === name);
    if (!j) return;
    await hc(["kill", j.addr]).catch(() => {});
    await hc(["rm", j.addr]).catch(() => {});
    delete this.live[j.addr];
    this.save((all) => all.filter((x) => x !== j && !(x.root === j.root && x.name === j.name)));
    cx.notify();
  }

  render() {
    const t = theme(), pkg = this.pkg, scripts = Object.entries(pkg?.scripts ?? {}), jobs = this.jobs();
    const green = "#3fae6a", red = "#e5534b";
    const iconBtn = (id, icon, fn) => div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); })
      .child(svg(icon).size(13));
    const row = ([name, cmd]) => {
      const s = this.stateOf(name);
      return h_flex().id(`script-${name}`).h(34).flex_none().px(10).gap(8).items_center().rounded(7).cursor_pointer()
        .hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => this.start(name, cx))
        .child(svg("mods/vnh-scripts/play.svg").size(12).flex_none().text_color(s === "running" ? green : t.muted))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(12.5).font_medium().child(name))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(String(cmd))));
    };
    const list = v_flex().size_full().min_h(0)
      .child(v_flex().flex_none().px(14).py(10).gap(2).border_b(1).border_color(t.border)
        .child(div().truncate().font_semibold().text_size(13).child(pkg?.name ?? "package.json"))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(`${this.root ? this.root.replace(home(), "~") : ""} · ${this.pm}`)))
      .child(div().id("scripts-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().p(6).gap(1)
          .when(Boolean(this.error), (el) => el.child(div().p(10).text_size(12).text_color(t.dim).child(this.error)))
          .when(!this.error && !scripts.length, (el) => el.child(div().p(10).text_size(12).text_color(t.dim).child("No scripts in package.json")))
          .children(scripts.map(row))));
    const section = (j) => {
      const st = this.live[j.addr] ?? { state: "running", code: null, text: "" }, running = st.state === "running";
      const mark = running ? div().size(7).rounded(4).bg(green).flex_none()
        : div().flex_none().text_size(10.5).text_color(st.code === 0 ? green : red).child(st.code === 0 ? "✓" : st.code == null ? "stopped" : `✗ ${st.code}`);
      const lines = st.text ? st.text.split("\n") : [running ? "Starting…" : ""];
      return v_flex().size_full().min_h(0).border_t(1).border_color(t.border)
        .child(h_flex().h(30).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
          .child(mark)
          .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().child(j.name))
          .child(iconBtn(`rs-${j.name}`, "mods/vnh-scripts/restart.svg", (cx) => this.restart(j.name, cx)))
          .when(running, (el) => el.child(iconBtn(`st-${j.name}`, "mods/vnh-scripts/stop.svg", (cx) => this.stop(j.name, cx))))
          .child(iconBtn(`rm-${j.name}`, "mods/pane/close.svg", (cx) => this.remove(j.name, cx))))
        .child(v_flex().flex_1().min_h(0).overflow_hidden().justify_end().px(10).py(6).font_family(FONT).text_size(11).line_height("15px").text_color(t.muted)
          .children(lines.map((l) => div().flex_none().whitespace_normal().child(l === "" ? " " : l))));
    };
    const root = v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground).font_family(FONT);
    if (!jobs.length) return root.child(list);
    return root.child(v_resizable(`scripts-split-${jobs.length}`).size_full().min_h(0)
      .child(resizable_panel().size(Math.min(240, 64 + 36 * Math.max(1, scripts.length))).size_range(90).child(list))
      .children(jobs.map((j) => resizable_panel().size(170).size_range(70).child(section(j)))));
  }
}

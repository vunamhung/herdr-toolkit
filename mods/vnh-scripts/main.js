// Scripts: the "scripts" of package.json in the project's root folder, as a panel tab. A click on one runs it (the package manager
// whose lock file is there: pnpm, yarn, bun, else npm) as a headless Herdr terminal (through `script`, which keeps its colours in a log file), and its output shows in a section of this
// panel under the list, a read-only log that scrolls and follows the end until you scroll it (↓ end brings it back). Jobs are tabs of that one window, and the
// divider between the list and the window drags; a job that ended keeps its output and shows its exit code.
// Stop kills it, Restart runs it again, ✕ removes it. `herdr-app do vnh-scripts.run-<script>` (also stop-, restart-) does the same.
// Cost: while the panel is on screen and a job runs, one `hc ls` and one `hc read` per running job every 1.5 s; nothing otherwise.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_resizable, resizable_panel, ScrollHandle } from "gpui-base";
import { theme, hc, exec, nextCommand, home, focused, panes, spaces, readTextFile, shared, setShared, window, layout, checking } from "herdr";

const FONT = "PragmataPro";
const JOBS = "vnh.scripts.jobs";
const KEEP = 400;                       // lines of a log kept for drawing
const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).reduce((h, c) => h ?? find(c, id), null));
const MANAGERS = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"]];
const slug = (x) => x.replace(/[^A-Za-z0-9._-]+/g, "_");
const BASE = ["#6b7280", "#e5534b", "#3fae6a", "#d9a441", "#5b8def", "#b07cf6", "#22a99a", "#c9d1d9", "#8b929c", "#ff7b72", "#56d364", "#e3b341", "#79a8ff", "#d2a8ff", "#39c5bb", "#f0f6fc"];
const hex2 = (x) => Math.max(0, Math.min(255, x || 0)).toString(16).padStart(2, "0");
function color256(n) {
  if (n < 16) return BASE[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `#${hex2(v)}${hex2(v)}${hex2(v)}`; }
  const k = n - 16, c = [Math.floor(k / 36), Math.floor(k / 6) % 6, k % 6].map((x) => (x ? 55 + x * 40 : 0));
  return `#${c.map(hex2).join("")}`;
}
// A terminal log (raw, as `script` wrote it) -> its last lines, each a list of runs { t: text, fg: colour | null, b: bold }.
// Only colours and bold are kept; a line redrawn with \r keeps its last drawing; every other control sequence is dropped.
function parseLog(raw) {
  const text = raw.replace(/\^D\u0008+/g, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-9;?]*[ -\/]*[@-ln-~]/g, "").replace(/\u001b[()][A-Za-z0-9]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f]/g, "");
  const out = [];
  for (const rawLine of text.split("\n")) {
    const segs = rawLine.split("\r").filter((x) => x.replace(/\u001b\[[0-9;]*m/g, "") !== "");
    const seg = segs.length ? segs[segs.length - 1] : "";
    const runs = []; let fg = null, b = false, last = 0, m;
    const re = /\u001b\[([0-9;]*)m/g;
    const push = (t) => { if (t) runs.push({ t, fg, b }); };
    while ((m = re.exec(seg))) {
      push(seg.slice(last, m.index)); last = re.lastIndex;
      const a = m[1] === "" ? [0] : m[1].split(";").map((x) => Number(x) || 0);
      for (let i = 0; i < a.length; i++) {
        const c = a[i];
        if (c === 0) { fg = null; b = false; } else if (c === 1) b = true; else if (c === 22) b = false;
        else if (c >= 30 && c <= 37) fg = BASE[c - 30]; else if (c >= 90 && c <= 97) fg = BASE[c - 90 + 8]; else if (c === 39) fg = null;
        else if (c === 38 && a[i + 1] === 5) { fg = color256(a[i + 2] ?? 7); i += 2; }
        else if (c === 38 && a[i + 1] === 2) { fg = `#${hex2(a[i + 2])}${hex2(a[i + 3])}${hex2(a[i + 4])}`; i += 4; }
      }
    }
    push(seg.slice(last));
    out.push(runs);
  }
  while (out.length && !out[out.length - 1].some((r) => r.t.trim())) out.pop();
  return out.slice(-KEEP);
}

export default class Scripts extends View {
  init(_props, cx) {
    this.root = null; this.cwd = null; this.pm = "npm"; this.pkg = null; this.error = ""; this.busy = false; this.sig = "";
    this.git = null; this.gitAt = 0;     // the git summary shown when there is nothing to run
    this.live = {};                     // address -> { state, code, text }
    this.sel = {};                      // folder -> the name of the job whose tab shows
    this.scrolls = {};                  // address -> its log's ScrollHandle
    this.still = {};                    // address -> true once you scrolled the log (it stops following the end)
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
      if ((error || !Object.keys(pkg?.scripts ?? {}).length) && this.root && (this.gitRoot !== this.root || Date.now() - this.gitAt > 60000)) await this.loadGit(this.root);
      const sig = JSON.stringify([pkg?.name, pkg?.scripts, error, this.pm, this.root, this.git]);
      if (sig !== this.sig) { this.sig = sig; this.pkg = pkg; this.error = error; cx.notify(); }
    } finally { this.busy = false; }
  }

  // `git summary` (git-extras) of the folder, shown when there is no package.json or no scripts: project, repo age, branch, last
  // active, commits, files, uncommitted, authors. Parsed from its output; at most once a minute, only while that is on screen.
  async loadGit(root) {
    this.gitRoot = root; this.gitAt = Date.now();
    const r = await exec("git", ["-C", root, "summary"]).catch(() => null);
    if (r?.code !== 0) { this.git = null; return; }
    const rows = [], authors = []; let inAuthors = false;
    for (const l of String(r.stdout).split("\n")) {
      const a = l.match(/^\s*(\d+)\s+(.+?)\s+([\d.]+%)\s*$/);
      if (inAuthors && a) { authors.push({ n: a[1], name: a[2], pct: a[3] }); continue; }
      const kv = l.match(/^\s*([^:]+?):?\s*:\s*(.*?)\s*$/);
      if (!kv) continue;
      if (kv[1].trim() === "authors") { inAuthors = true; continue; }
      rows.push([kv[1].trim().replace(/:$/, ""), kv[2]]);
    }
    this.git = rows.length ? { rows, authors } : null;
  }

  // The jobs of this folder, in the order they were started: { name, addr, cmd }.
  all() { const v = shared(JOBS); return Array.isArray(v) ? v : []; }
  jobs() { return this.all().filter((j) => j.root === this.root); }
  save(fn) { setShared(JOBS, fn(this.all())); }

  // One `hc ls` for the state of every job, and a read of the output of those still running (plus one last read when one ends).
  async poll(cx) {
    const jobs = this.jobs();
    for (const j of jobs) this.scrolls[j.addr] ??= ScrollHandle.new();
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
        const ended = !row || row.state !== "live";
        const out = await exec("tail", ["-c", "150000", j.log]).catch(() => null);
        const raw = out?.code === 0 ? String(out.stdout) : prev?.raw ?? "";
        const next = { state: ended ? "exited" : "running", code: ended ? row?.exit_code ?? null : null, raw, lines: prev && prev.raw === raw ? prev.lines : parseLog(raw) };
        if (!prev || prev.state !== next.state || prev.code !== next.code || prev.raw !== next.raw) { this.live[j.addr] = next; changed = true; }
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
    const log = `${home()}/.cache/vnh-scripts/${slug(root)}__${slug(name)}.log`;
    const r = await hc(["run", "--bg", "--no-parent", "--outlive-parent", "--label", "vnh.scripts=1", "--cwd", root, "--json", "--",
      "/bin/sh", "-c", 'mkdir -p "$(dirname "$0")" && exec script -q "$0" /bin/zsh -lic "$1"', log, cmd]).catch(() => null);
    let addr = null; try { addr = JSON.parse(r?.stdout ?? "{}").address ?? null; } catch {}
    if (!addr) return;
    this.save((all) => [...all.filter((j) => !(j.root === root && j.name === name)), { root, name, addr, cmd, log }]);
    this.live[addr] = { state: "running", code: null, raw: "", lines: [] };
    this.scrolls[addr] ??= ScrollHandle.new();
    this.sel[root] = name; delete this.still[addr];
    cx.notify();
    this.poll(cx);
  }

  async stop(name, cx) {
    const j = this.jobs().find((x) => x.name === name);
    if (!j) return;
    await hc(["kill", j.addr]).catch(() => {});
    this.live[j.addr] = { ...(this.live[j.addr] ?? { raw: "", lines: [] }), state: "running", code: null };   // the next poll reads its end
    this.polling = false; this.poll(cx);
  }

  async restart(name, cx) {
    const j = this.jobs().find((x) => x.name === name);
    if (j && this.stateOf(name) === "running") { await hc(["kill", j.addr]).catch(() => {}); await new Promise((ok) => cx.timer.after(400, () => ok(null))); this.live[j.addr] = { state: "exited", code: null, raw: "", lines: [] }; }
    this.start(name, cx);
  }

  async remove(name, cx) {
    const j = this.jobs().find((x) => x.name === name);
    if (!j) return;
    await hc(["kill", j.addr]).catch(() => {});
    await hc(["rm", j.addr]).catch(() => {});
    delete this.live[j.addr]; delete this.still[j.addr];
    try { this.scrolls[j.addr]?.release(); } catch {}
    delete this.scrolls[j.addr];
    if (this.sel[j.root] === j.name) delete this.sel[j.root];
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
    const gitSummary = () => {
      const g = this.git;
      return v_flex().gap(10).p(8)
        .child(div().text_size(11).text_color(t.dim).child(this.error || "No scripts in package.json"))
        .child(v_flex().gap(3).children(g.rows.map(([k, v], i) => h_flex().id(`gs-${i}`).gap(10).text_size(12)
          .child(div().w(92).flex_none().text_color(t.dim).child(k))
          .child(div().flex_1().min_w(0).truncate().child(v || "–")))))
        .when(g.authors.length > 0, (el) => el.child(v_flex().gap(3)
          .child(div().text_size(11).text_color(t.dim).child("authors"))
          .children(g.authors.slice(0, 8).map((a, i) => h_flex().id(`ga-${i}`).gap(8).text_size(12)
            .child(div().w(34).flex_none().text_right().text_color(t.dim).child(a.n))
            .child(div().flex_1().min_w(0).truncate().child(a.name))
            .child(div().flex_none().text_color(t.dim).child(a.pct))))));
    };
    const list = v_flex().size_full().min_h(0)
      .child(v_flex().flex_none().px(14).py(10).gap(2).border_b(1).border_color(t.border)
        .child(div().truncate().font_semibold().text_size(13).child(pkg?.name ?? (this.root ? this.root.split("/").pop() : "Scripts")))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(`${this.root ? this.root.replace(home(), "~") : ""} · ${this.pm}`)))
      .child(div().id("scripts-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().p(6).gap(1)
          .when(Boolean(this.error) && !this.git, (el) => el.child(div().p(10).text_size(12).text_color(t.dim).child(this.error)))
          .when(!this.error && !scripts.length && !this.git, (el) => el.child(div().p(10).text_size(12).text_color(t.dim).child("No scripts in package.json")))
          .when((Boolean(this.error) || !scripts.length) && Boolean(this.git), (el) => el.child(gitSummary()))
          .children(scripts.map(row))));
    const line = (runs) => {
      if (runs.length <= 1 && !runs[0]?.fg && !runs[0]?.b) return div().flex_none().whitespace_normal().child(runs[0]?.t || " ");
      return h_flex().flex_none().flex_wrap().children(runs.flatMap((r) => (r.t.match(/\S+\s*|\s+/g) ?? []).map((w) =>
        div().flex_none().whitespace_nowrap().when(Boolean(r.fg), (el) => el.text_color(r.fg)).when(r.b, (el) => el.font_semibold()).child(w))));
    };
    const active = jobs.find((j) => j.name === this.sel[this.root]) ?? jobs[jobs.length - 1];
    const tab = (j) => {
      const st = this.live[j.addr] ?? { state: "running", code: null }, on = j === active, running = st.state === "running";
      const mark = running ? div().size(7).rounded(4).bg(green).flex_none()
        : div().flex_none().text_size(10.5).text_color(st.code === 0 ? green : red).child(st.code === 0 ? "✓" : st.code == null ? "■" : `✗${st.code}`);
      return h_flex().id(`tab-${j.name}`).h(26).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer().text_size(12)
        .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => { this.sel[this.root] = j.name; cx.notify(); })
        .child(mark).child(div().child(j.name))
        .child(iconBtn(`rm-${j.name}`, "mods/pane/close.svg", (cx) => this.remove(j.name, cx)));
    };
    const logWindow = () => {
      const j = active, st = this.live[j.addr] ?? { state: "running", code: null, raw: "", lines: [] }, running = st.state === "running";
      const lines = st.lines?.length ? st.lines : [[{ t: running ? "Starting…" : "", fg: null, b: false }]];
      const handle = this.scrolls[j.addr] ?? null;       // made in an event (ScrollHandle.new() cannot run while rendering)
      const follow = !this.still[j.addr];
      if (follow && handle) handle.scroll_to_item(lines.length - 1);
      return v_flex().size_full().min_h(0).border_t(1).border_color(t.border)
        .child(h_flex().h(34).flex_none().px(6).gap(3).items_center().border_b(1).border_color(t.border)
          .child(h_flex().id("job-tabs").flex_1().min_w(0).gap(3).items_center().overflow_x_scroll().children(jobs.map(tab)))
          .child(iconBtn("job-restart", "mods/vnh-scripts/restart.svg", (cx) => this.restart(j.name, cx)))
          .when(running, (el) => el.child(iconBtn("job-stop", "mods/vnh-scripts/stop.svg", (cx) => this.stop(j.name, cx)))))
        .child(div().flex_1().min_h(0).relative()
          .child(v_flex().id(`log-${j.addr}`).size_full().px(10).py(6).font_family(FONT).text_size(11).line_height("15px").text_color(t.muted)
            .overflow_y_scrollbar().when(Boolean(handle), (el) => el.track_scroll(handle))
            .on_scroll_wheel((_e, cx) => { if (!this.still[j.addr]) { this.still[j.addr] = true; cx.notify(); } })
            .children(lines.map(line)))
          .when(!follow, (el) => el.child(div().id("log-end").absolute().right(16).bottom(8).h(24).px(10).flex().items_center().rounded(12).cursor_pointer()
            .bg(t.selected).text_color(t.foreground).text_size(11).hover((x) => x.bg(t.hover))
            .on_click((_e, cx) => { delete this.still[j.addr]; cx.notify(); }).child("↓ end"))));
    };
    const root = v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground).font_family(FONT);
    if (!jobs.length) return root.child(list);
    return root.child(v_resizable("scripts-split").size_full().min_h(0)
      .child(resizable_panel().size(Math.min(240, 64 + 36 * Math.max(1, scripts.length))).size_range(90).child(list))
      .child(resizable_panel().size(260).size_range(100).child(logWindow())));
  }
}

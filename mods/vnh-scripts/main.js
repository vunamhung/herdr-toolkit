// Scripts: the "scripts" of package.json in the project's root folder, as a panel tab. A click on one runs it (the package manager
// whose lock file is there: pnpm, yarn, bun, else npm) as a headless Herdr terminal (through `script`, which keeps its colours in a log file), and its output shows in a section of this
// panel under the list, a read-only log that scrolls and follows the end until you scroll it (↓ end brings it back). Jobs are tabs of that one window, and the
// divider between the list and the window drags; a job that ended keeps its output and shows its exit code.
// Stop kills it, Restart runs it again, ✕ removes it. `herdr-app do vnh-scripts.run-<script>` (also stop-, restart-) does the same.
// `script -t 0`: its log is flushed at every write (its default is every 30 s, which showed a job's output seconds late).
// Cost: while the panel is on screen and a job runs, one `hc ls` and one `hc read` per running job every 1.5 s; nothing otherwise.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_resizable, resizable_panel, ScrollHandle } from "gpui-base";
import { theme, hc, exec, nextCommand, home, writeTextFile, focused, panes, spaces, readTextFile, shared, setShared, window, layout, checking } from "herdr";

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
// A terminal log (raw, as `script` wrote it) -> its last lines, each a list of runs { t: text, fg: colour | null, b: bold }. A small
// terminal emulator: text lands where the cursor is (a line redrawn with \r, vite's "(x2)" that moves up one line and writes over it),
// colours and bold are kept, clearing the line / the screen works; "home + erase below" (vite's clear screen) wipes what came before.
function parseLog(raw0) {
  const raw = raw0.replace(/\^D\u0008+/g, "");
  let rows = [[]], r = 0, c = 0, fg = null, b = false, home = false;
  const row = () => (rows[r] ??= []);
  const goto = (nr) => { r = Math.max(0, nr); while (rows.length <= r) rows.push([]); };
  const wipe = () => { rows = [[]]; r = 0; c = 0; };
  const CSI = /\u001b\[([0-9;?]*)([ -\/]*)([@-~])/y;
  const sgr = (a) => {
    for (let i = 0; i < a.length; i++) {
      const k = a[i];
      if (k === 0) { fg = null; b = false; } else if (k === 1) b = true; else if (k === 22) b = false;
      else if (k >= 30 && k <= 37) fg = BASE[k - 30]; else if (k >= 90 && k <= 97) fg = BASE[k - 90 + 8]; else if (k === 39) fg = null;
      else if (k === 38 && a[i + 1] === 5) { fg = color256(a[i + 2] ?? 7); i += 2; }
      else if (k === 38 && a[i + 1] === 2) { fg = `#${hex2(a[i + 2])}${hex2(a[i + 3])}${hex2(a[i + 4])}`; i += 4; }
    }
  };
  const csi = (params, fin) => {
    const a = params.replace(/\?/g, "").split(";").map((x) => (x === "" ? NaN : Number(x))), n1 = Number.isNaN(a[0]) ? 1 : Math.max(1, a[0]);
    const wasHome = home; home = false;
    switch (fin) {
      case "m": sgr(params === "" ? [0] : params.split(";").map((x) => Number(x) || 0)); break;
      case "A": goto(r - n1); break;
      case "B": goto(r + n1); break;
      case "C": c += n1; break;
      case "D": c = Math.max(0, c - n1); break;
      case "E": goto(r + n1); c = 0; break;
      case "F": goto(r - n1); c = 0; break;
      case "G": c = n1 - 1; break;
      case "H": case "f": {
        const rr = Number.isNaN(a[0]) ? 1 : a[0], cc = Number.isNaN(a[1]) ? 1 : a[1];
        if (rr <= 1 && cc <= 1) { home = true; r = 0; c = 0; } else { goto(rr - 1); c = cc - 1; }
        break;
      }
      case "K": { const m = Number.isNaN(a[0]) ? 0 : a[0], rw = row();
        if (m === 0) rw.length = Math.min(rw.length, c); else if (m === 1) { for (let i = 0; i <= c && i < rw.length; i++) rw[i] = { ch: " ", fg: null, b: false }; } else rw.length = 0; break; }
      case "J": { const m = Number.isNaN(a[0]) ? 0 : a[0];
        if (m === 2 || m === 3 || (m === 0 && wasHome)) wipe(); else if (m === 0) { row().length = Math.min(row().length, c); rows.length = r + 1; } break; }
      case "P": { const rw = row(); rw.splice(c, n1); break; }
      default: break;
    }
  };
  for (let i = 0; i < raw.length;) {
    const ch = raw[i];
    if (ch === "\u001b") {
      const nx = raw[i + 1];
      if (nx === "[") { CSI.lastIndex = i; const m = CSI.exec(raw); if (!m) break; i = CSI.lastIndex; csi(m[1], m[3]); continue; }
      if (nx === "]") { const bel = raw.indexOf("\u0007", i), st = raw.indexOf("\u001b\\", i); const e = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st); if (e < 0) break; i = e + (raw[e] === "\u0007" ? 1 : 2); continue; }
      if (nx === "c") { wipe(); i += 2; continue; }
      if (nx === "(" || nx === ")") { i += 3; continue; }
      i += 2; continue;
    }
    if (ch === "\r") { c = 0; i++; continue; }
    if (ch === "\n") { goto(r + 1); i++; continue; }
    if (ch === "\u0008") { c = Math.max(0, c - 1); i++; continue; }
    if (ch === "\t") { c = (c + 8) & ~7; i++; continue; }
    if (ch < " " || ch === "\u007f") { i++; continue; }
    home = false;
    const cp = String.fromCodePoint(raw.codePointAt(i)); i += cp.length;
    const rw = row(); while (rw.length < c) rw.push({ ch: " ", fg: null, b: false });
    rw[c] = { ch: cp, fg, b }; c++;
  }
  const out = rows.map((rw) => {
    const runs = [];
    for (const cell of rw) {
      const last = runs[runs.length - 1];
      if (last && last.fg === cell.fg && last.b === cell.b) last.t += cell.ch; else runs.push({ t: cell.ch, fg: cell.fg, b: cell.b });
    }
    if (runs.length) runs[runs.length - 1].t = runs[runs.length - 1].t.replace(/\s+$/, "");
    return runs.filter((x) => x.t !== "");
  });
  // No blank line at the start or the end, and at most one in a row.
  const blank = (l) => !l.some((x) => x.t.trim());
  const tidy = [];
  for (const l of out) { if (blank(l) && (!tidy.length || blank(tidy[tidy.length - 1]))) continue; tidy.push(l); }
  while (tidy.length && blank(tidy[tidy.length - 1])) tidy.pop();
  return tidy.slice(-KEEP);
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
    // Looks at the jobs every 0.5 s during the first 10 s of one (its first lines), every 1.5 s after.
    cx.timer.every(500, (cx) => {
      const now = Date.now();
      if (now - (this.lastPoll ?? 0) < (now < (this.burst ?? 0) ? 450 : 1450)) return;
      if (window()?.active !== false && this.shownNow()) { this.lastPoll = now; this.poll(cx); }
    });
    this.loginPath(cx);
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

  // The PATH a login shell gives (nvm, pnpm, homebrew), asked once and kept for a day: a job then starts under a plain `sh` with it,
  // not under `zsh -lic` (reading the whole zshrc costs about 0.8 s on every start).
  async loginPath(cx) {
    const file = `${home()}/.cache/vnh-scripts/path.txt`;
    const old = await readTextFile(file).catch(() => null);
    let saved = null; try { saved = JSON.parse(old ?? "null"); } catch {}
    if (saved?.path && saved?.env && Date.now() - saved.at < 86400000) { this.path = saved.path; this.env = saved.env; return; }
    // `env` of a login shell: PATH and the rest (NVM_DIR, PNPM_HOME, COREPACK_*...), minus what belongs to the session that asked.
    const r = await exec("/bin/zsh", ["-lic", "env"], { timeout: 15000 }).catch(() => null);
    const env = {};
    for (const l of String(r?.stdout ?? "").split("\n")) {
      const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && !/^(CLAUDE|AI_AGENT|OLDPWD|PWD|SHLVL|_|HC_|TERM_SESSION|ITERM|P9K|GITSTATUS)/.test(m[1])) env[m[1]] = m[2];
    }
    if (r?.code === 0 && env.PATH?.includes("/")) {
      this.path = env.PATH; this.env = env;
      await exec("mkdir", ["-p", `${home()}/.cache/vnh-scripts`]).catch(() => {});
      await writeTextFile(file, JSON.stringify({ path: env.PATH, env, at: Date.now() }), null).catch(() => {});
    }
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
    // With the login PATH known: plain sh (fast). Without it yet: the login shell, as before.
    const inner = this.path ? ["/usr/bin/env", ...Object.entries(this.env ?? { PATH: this.path }).map(([k, v]) => `${k}=${v}`), "/bin/sh", "-c", 'mkdir -p "$(dirname "$0")" && exec script -q -t 0 "$0" /bin/sh -c "$1"']
      : ["/bin/sh", "-c", 'mkdir -p "$(dirname "$0")" && exec script -q -t 0 "$0" /bin/zsh -lic "$1"'];
    const r = await hc(["run", "--bg", "--no-parent", "--outlive-parent", "--label", "vnh.scripts=1", "--cwd", root, "--json", "--", ...inner, log, cmd]).catch(() => null);
    let addr = null; try { addr = JSON.parse(r?.stdout ?? "{}").address ?? null; } catch {}
    if (!addr) return;
    this.save((all) => [...all.filter((j) => !(j.root === root && j.name === name)), { root, name, addr, cmd, log }]);
    this.live[addr] = { state: "running", code: null, raw: "", lines: [] };
    this.burst = Date.now() + 10000; this.lastPoll = 0;
    this.scrolls[addr] ??= ScrollHandle.new();
    this.sel[root] = name; delete this.still[addr];
    cx.notify();
    this.poll(cx);
  }

  // Ends a job and everything it started. `hc kill` only ends the terminal's own program (here `script`); the shell under it and the
  // server it runs (vite...) would stay up, holding their port. So: every descendant of that program gets TERM, then KILL if it stays.
  async killTree(addr, cx) {
    const g = await hc(["get", addr, "--json"]).catch(() => null);
    let pid = 0; try { pid = Number(JSON.parse(g?.stdout ?? "{}").pid) || 0; } catch {}
    const family = async () => {
      const ps = await exec("ps", ["-Ao", "pid=,ppid="]).catch(() => null);
      const kids = new Map();
      for (const l of String(ps?.stdout ?? "").split("\n")) { const m = l.trim().match(/^(\d+)\s+(\d+)$/); if (m) (kids.get(+m[2]) ?? kids.set(+m[2], []).get(+m[2])).push(+m[1]); }
      const all = []; const walk = (p) => { for (const c of kids.get(p) ?? []) { all.push(c); walk(c); } };
      if (pid) walk(pid);
      return all;
    };
    const first = pid ? await family() : [];
    if (first.length) await exec("kill", ["-TERM", ...first.map(String)]).catch(() => {});
    await hc(["kill", addr]).catch(() => {});
    if (first.length) {
      let left = first;
      for (let i = 0; i < 12 && left.length; i++) {
        await new Promise((ok) => cx.timer.after(100, () => ok(null)));
        const ps = await exec("ps", ["-Ao", "pid="]).catch(() => null);
        const alive = new Set(String(ps?.stdout ?? "").split("\n").map((x) => +x.trim()));
        left = left.filter((p) => alive.has(p));
      }
      if (left.length) await exec("kill", ["-KILL", ...left.map(String)]).catch(() => {});
    }
  }

  async stop(name, cx) {
    const j = this.jobs().find((x) => x.name === name);
    if (!j) return;
    await this.killTree(j.addr, cx);
    this.live[j.addr] = { ...(this.live[j.addr] ?? { raw: "", lines: [] }), state: "running", code: null };   // the next poll reads its end
    this.polling = false; this.poll(cx);
  }

  async restart(name, cx) {
    const j = this.jobs().find((x) => x.name === name);
    if (j && this.stateOf(name) === "running") { await this.killTree(j.addr, cx); await new Promise((ok) => cx.timer.after(400, () => ok(null))); this.live[j.addr] = { state: "exited", code: null, raw: "", lines: [] }; }
    this.start(name, cx);
  }

  // The tab goes at once; ending the job (and everything it started) and removing its terminal follow in the background.
  async remove(name, cx) {
    const j = this.jobs().find((x) => x.name === name);
    if (!j) return;
    delete this.live[j.addr]; delete this.still[j.addr];
    if (this.sel[j.root] === j.name) delete this.sel[j.root];
    this.save((all) => all.filter((x) => x !== j && !(x.root === j.root && x.name === j.name)));
    cx.notify();
    const handle = this.scrolls[j.addr]; delete this.scrolls[j.addr];
    await this.killTree(j.addr, cx);
    await hc(["rm", j.addr]).catch(() => {});
    try { handle?.release(); } catch {}
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

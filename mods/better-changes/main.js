// Modified for herdr-toolkit from munza/herdr-mods `better-changes` (Apache-2.0). See THIRD-PARTY-NOTICES.md.
// Better Changes: a Git sidebar, and the diff tab it opens in the centre. One
// class plays both roles; shared("better-changes.*") connects the copies.
// The class is built from separate files, so a method used here may live in any of:
//   git/repository.js   following the repository, the index, history, commit and amend
//   views/sidebar.js    the tabs, options menu, file groups and commit views
//   views/diff.js       opening a file in the centre tab, reading it, and drawing it
//   views/pane-header.js  the header row above a pane
// git/reads.js reads from Git, git/model.js parses its output, views/ui.js holds every look
// but the token colours: syntax.js colours a diff's code, and Better Files has the same file.
import { View } from "gpui-kit";
import { TextareaState } from "gpui-base";
import { props, shared, setShared, nextCommand, layout, run, notify, closeOverlay, exec, home, focused, panes, agents, readTextFile } from "herdr";
import { loadSettings, duration } from "./settings.js";
import { followFileIcons } from "./file-icons.js";
import { panelCommands } from "./panel.js";
import { gitMethods } from "./git/repository.js";
import { sidebarMethods } from "./views/sidebar.js";
import { diffMethods } from "./views/diff.js";
import { paneHeaderMethods } from "./views/pane-header.js";
import { pullsMethods } from "./views/pulls.js";

// VNH: which of the changed files the agent(s) in view wrote, for "only this session's files". Run in the repository. A file's modification
// time says when it was written; the ledger (vnh-agents/ledger.js: when each agent was working, in which folder) says who was active
// then. One agent: it is that agent's. Several at once: the agents' own records break the tie (a Claude transcript's Write / Edit time and
// shell command windows, agy's edit_file / write_file steps), and what stays undecided counts for all of them. Nobody working: a hand
// edit, nobody's. Before the ledger began, the agents' records alone decide. Those records are read incrementally (a cache per file).
// Prints {paths: [relative to the repository, still changed]}.
const SESSION_PY = String.raw`import sys, os, re, json, glob, subprocess, sqlite3, datetime, hashlib, time
home = os.path.expanduser("~")
root = os.getcwd()
LEDGER = os.environ.get("VNH_LEDGER_DIR") or home + "/.local/state/herdr-ledger"
CACHE = os.environ.get("VNH_LEDGER_CACHE") or home + "/.cache/vnh-ledger"
now = time.time()
mine_ids = set()           # the agent(s) in view: session ids, and "t:<terminal>" for a terminal whose session is not known yet
for a in sys.argv[1:]:
    if a.startswith("s:") and re.fullmatch(r"[0-9a-f-]{36}", a[2:]): mine_ids.add(a[2:])
    elif a.startswith("t:") and re.fullmatch(r"[A-Za-z0-9_-]+", a[2:]): mine_ids.add(a)
WRITE = ("Write", "Edit", "MultiEdit", "NotebookEdit")
top = root.rstrip("/") + "/"
rel = lambda q: q[len(top):] if isinstance(q, str) and q.startswith(top) else None

def stamp(s):
    try: return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception: return None

# ── what is changed now, and when each file was last written ───────────────────────────────────────────────────────────────
changed = {}
r = subprocess.run(["git", "--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], capture_output=True)
for ent in r.stdout.split(b"\0"):
    if len(ent) < 4: continue
    p = ent[3:].decode("utf8", "replace")
    try: changed[p] = os.lstat(os.path.join(root, p)).st_mtime
    except OSError: changed[p] = None

# ── the ledger: when each agent was working (written by the Agents list, vnh-agents) ───────────────────────────────────────
runs, open_by_term, t0 = [], {}, None
try:
    for line in open(LEDGER + "/runs.jsonl", "rb"):
        try: e = json.loads(line)
        except Exception: continue
        t = e.get("t")
        if not isinstance(t, (int, float)): continue
        t = t / 1000.0
        if t0 is None: t0 = t
        term, ev = e.get("term"), e.get("ev")
        if ev == "boot":                     # Herdr was restarted: whatever was running then was not seen to stop
            for k, v in list(open_by_term.items()): runs.append((v[0], t, v[1], v[2])); open_by_term.pop(k)
        elif ev == "start":
            if term in open_by_term: v = open_by_term.pop(term); runs.append((v[0], t, v[1], v[2]))
            open_by_term[term] = (t, e.get("sid") or ("t:" + str(term)), e.get("cwd") or "")
        elif ev == "stop" and term in open_by_term:
            v = open_by_term.pop(term)
            runs.append((v[0], t, e.get("sid") or v[1], v[2]))
except OSError:
    pass
for term, v in open_by_term.items(): runs.append((v[0], now + 5, v[1], v[2]))   # still working

def related(cwd):
    if not cwd: return False
    c = cwd.rstrip("/") + "/"
    return c.startswith(top) or (top.startswith(c) and c.count("/") >= 4)

# ── what each agent's own record says (Claude transcripts, agy conversation files), read incrementally ──────────────────────
os.makedirs(CACHE, exist_ok=True)
evidence_cache = {}
def evidence(sid):
    """{'exact': {rel path: last Write/Edit time or None}, 'wins': [(from, to)], 'last': time of the last record}"""
    if sid in evidence_cache: return evidence_cache[sid]
    ev = {"exact": {}, "wins": [], "last": 0.0}
    if not re.fullmatch(r"[0-9a-f-]{36}", sid or ""):
        evidence_cache[sid] = ev; return ev
    base = glob.glob("%s/.claude/projects/*/%s.jsonl" % (home, sid)) + glob.glob("%s/.ccs/instances/*/projects/*/%s.jsonl" % (home, sid))
    for path in base + [x for b in base for x in glob.glob(b[:-6] + "/subagents/*.jsonl")]:
        key = CACHE + "/" + hashlib.sha1(path.encode()).hexdigest() + ".json"
        st = {"off": 0, "exact": {}, "wins": [], "starts": {}, "last": 0.0}
        try:
            st = json.load(open(key))
        except Exception:
            pass
        try:
            size = os.path.getsize(path)
            if st["off"] > size: st = {"off": 0, "exact": {}, "wins": [], "starts": {}, "last": 0.0}
            if size > st["off"]:
                with open(path, "rb") as f:
                    f.seek(st["off"]); data = f.read()
                end = data.rfind(b"\n")
                if end >= 0:
                    for line in data[:end + 1].split(b"\n"):
                        if b'"tool_use' not in line and b'"tool_result"' not in line: continue
                        try: e = json.loads(line)
                        except Exception: continue
                        t = stamp(e.get("timestamp"))
                        if t: st["last"] = max(st["last"], t)
                        c = (e.get("message") or {}).get("content")
                        if not isinstance(c, list): continue
                        for it in c:
                            if not isinstance(it, dict): continue
                            if it.get("type") == "tool_use":
                                i = it.get("input") or {}
                                if it.get("name") in WRITE:
                                    q = i.get("file_path") or i.get("notebook_path")
                                    if isinstance(q, str): st["exact"][q] = t or 0
                                elif it.get("name") == "Bash" and t and not i.get("run_in_background"):
                                    st["starts"][it.get("id")] = t
                            elif it.get("type") == "tool_result":
                                s0 = st["starts"].pop(it.get("tool_use_id"), None)
                                if s0 and t and t - s0 < 180: st["wins"].append([s0 - 1.0, t + 1.5])
                    st["off"] += end + 1
                    st["wins"] = st["wins"][-3000:]
                    tmp = key + ".tmp"
                    with open(tmp, "w") as f: json.dump(st, f)
                    os.replace(tmp, key)
        except Exception:
            pass
        for q, t in st["exact"].items():
            r_ = rel(q)
            if r_: ev["exact"][r_] = max(ev["exact"].get(r_) or 0, t or 0) or None
        ev["wins"] += [tuple(w) for w in st["wins"]]
        ev["last"] = max(ev["last"], st["last"])
    db = "%s/.gemini/antigravity-cli/conversations/%s.db" % (home, sid)
    if os.path.exists(db):
        try:
            ev["last"] = max(ev["last"], os.path.getmtime(db) + 20)
            con = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=1)
            for (pl,) in con.execute("select step_payload from steps where step_type=132"):
                b = bytes(pl or b"")
                for tool in (b"edit_file", b"write_file"):
                    i = b.find(tool + b"\x1a")
                    if i < 0: continue
                    m = re.search(rb'"Path":"((?:[^"\\]|\\.)*)"', b[i:i + 400000])
                    if m:
                        try: q = rel(json.loads(b'"' + m.group(1) + b'"'))
                        except Exception: q = None
                        if q: ev["exact"].setdefault(q, None)
                    break
        except Exception:
            pass
    evidence_cache[sid] = ev
    return ev

def proof(sid, p, m):
    """2: the agent's own record puts a write of this file at this time; 1: one of its shell commands was running; 0: nothing."""
    ev = evidence(sid)
    if p in ev["exact"]:
        ts = ev["exact"][p]
        if ts and abs(ts - m) <= 4: return 2
        if ts is None and (not ev["last"] or m <= ev["last"] + 5): return 1     # agy: the path is in its steps, with no time
    if any(a <= m <= b for a, b in ev["wins"]): return 1
    return 0

# ── who wrote each changed file ─────────────────────────────────────────────────────────────────────────────────────────────
out, shared, covered = set(), 0, 0
for p, m in changed.items():
    if m is None:                                    # deleted: only the agents' own records can tell
        if any(p in evidence(s)["exact"] for s in mine_ids if not s.startswith("t:")): out.add(p)
        continue
    cands = {}
    for a, b, sid, cwd in runs:
        if a - 2 <= m <= b + 2 and related(cwd): cands[sid] = max(cands.get(sid, 0), 1)
    if t0 is not None and m >= t0 - 2:
        covered += 1
        if cands:
            scored = {s: proof(s, p, m) for s in cands}
            best = max(scored.values())
            owners = [s for s, v in scored.items() if v == best] if best else list(cands)
            if len(owners) > 1: shared += 1
        else:                                        # nobody was seen working: a status lag, or a hand edit
            owners = [s for s in mine_ids if not s.startswith("t:") and proof(s, p, m) >= 2]
    else:                                            # before the ledger began: the agents' own records alone
        owners = [s for s in mine_ids if not s.startswith("t:") and proof(s, p, m) >= 1 and (not evidence(s)["last"] or m <= evidence(s)["last"] + 5)]
    if mine_ids.intersection(owners): out.add(p)
print(json.dumps({"paths": sorted(out), "all": len(changed), "covered": covered, "shared": shared, "runs": len(runs)}))
`;
const CONTEXT_POLL_MS = 300;
const STATUS_POLL_MS = 10000;
// Preferences a person may change in the installed mod.json under `settings`.
const DEFAULT_SETTINGS = {
  refresh: { status: "10s" },
  limits: { files: 1000, diff_lines: 1500, line_length: 4000, commits_per_page: 50 },
  default: { view: "tree", diff: "inline" },
  panel: { toggle: false },
};

class BetterChanges extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    // Herdr hands a pane header its pane. One copy runs per pane, so it reads no Git.
    if (p.pane) {
      this.mode = "pane-header";
      this.hovered = false;
      return;
    }
    if (p.overlay) {
      this.mode = "panel-key";
      this.runPanelKey(p.overlay, cx);
      return;
    }
    this.mode = p.mode ?? "sidebar";
    this.diffSpace = p.space;
    this.source = p.source;
    this.settings = DEFAULT_SETTINGS;
    this.restoreDiffSelection(p);
    // Better Tabs draws this on the diff tab.
    setShared("mod-icons", {
      ...(shared("mod-icons") ?? {}),
      "better-changes": "mods/better-changes/icons/file.svg",
    });
    followFileIcons(this, cx);

    { const saved = localStorage.getItem("tab"); this.tab = saved === "commit" || saved === "stash" || saved === "pr" ? saved : "changes"; }
    // VNH: "columns" is a flat list with name, folder and changes in aligned columns.
    this.view = ["flat", "columns"].includes(localStorage.getItem("view")) ? localStorage.getItem("view") : "tree";
    // VNH: "fluid" (one list) or "split" (Unstaged above, Staged below, each scrolling).
    this.staging = localStorage.getItem("vnh-staging") === "split" ? "split" : "fluid";
    this.diffLayout =
      shared("better-changes.diff-layout") ??
      (localStorage.getItem("diff-layout") === "split" ? "split" : "inline");
    if (this.mode === "sidebar") setShared("better-changes.diff-layout", this.diffLayout);
    // VNH: "only this session's files" (⋮ menu): the Changes list keeps what the agent in view wrote.
    try { this.sessionOnly = localStorage.getItem("vnh-session-only") === "1"; } catch { this.sessionOnly = false; }
    this.mine = null; this.mineKey = ""; this.mineAt = 0;
    this.menuOpen = false;
    this.menuFocus = cx.focus_handle();
    this.viewMenuFocus = cx.focus_handle(); // VNH: the view dropdown (renderViewMenu)
    // VNH: the diff tab takes the keyboard so Esc closes it (renderDiff).
    // Focus can't change during render: a timer takes it when the tab shows (opened or selected again).
    if (this.mode === "diff") {
      this.diffKeys = cx.focus_handle();
      cx.timer.every(300, () => {
        const { showing } = this.vnhDiffTab();
        if (showing && !this.diffShowing) this.diffKeys.focus();
        this.diffShowing = showing;
      });
    }
    this.closed = new Set();
    this.collapsed = new Set(JSON.parse(localStorage.getItem("collapsed") ?? "[]"));
    this.files = [];
    this.rows = [];
    this.splitOffset = 0;
    this.diffToken = 0;
    this.resetCommits();
    this.resetPulls();
    this.prFilter = localStorage.getItem("vnh-pr-filter") ?? "all";
    if (this.mode === "sidebar") this.initCommitBox(cx);

    cx.timer.every(CONTEXT_POLL_MS, (cx) => this.follow(cx));
    this.applySettings(cx);
    cx.spawn(async (cx) => {
      for (;;) this.command(await nextCommand(), cx);
    });
    this.refresh(cx);
  }

  // `mod.open:better-changes` from a key. `<mod>.<command>` can't reach a hidden
  // panel, so a copy opens as an overlay for a moment and acts on the layout.
  runPanelKey(overlay, cx) {
    cx.spawn(async () => {
      try {
        const { settings } = await loadSettings("better-changes", DEFAULT_SETTINGS);
        const commands = panelCommands(layout(), "better-changes", settings.panel.toggle);
        if (commands) for (const [name, args] of commands) run(name, args);
        else notify({ title: "Better Changes isn't in this layout" });
      } finally {
        closeOverlay(overlay);
      }
    });
  }

  initCommitBox(cx) {
    this.message = "";
    this.messageRevision = 0;
    this.commitMode = "commit";
    this.commitMenuOpen = false;
    this.commitMenuFocus = cx.focus_handle();
    this.amendToken = 0;
    this.amendLoading = false;
    this.amendHead = null;
    this.typing = false;
    // Enter makes a new line here; only the button commits.
    this.input = TextareaState.new({ placeholder: "Commit message", rows: 4 });
    // VNH: grows with a long (generated) message, 4 to 10 rows, then scrolls.
    this.input.set_auto_grow(4, 10);
    this.input.on("change", (_e, cx) => {
      this.message = this.input.value();
      this.messageRevision++;
      cx.notify();
    });
    this.input.on("focus", (_e, cx) => {
      this.typing = true;
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => {
      this.typing = false;
      cx.notify();
    });
  }

  // Read the installed mod.json once, then start the status poll at its pace.
  // The view and diff defaults apply only where nothing was chosen before.
  applySettings(cx) {
    cx.spawn(async (cx) => {
      const { settings, problems } = await loadSettings("better-changes", DEFAULT_SETTINGS);
      for (const problem of problems) console.warn(`better-changes mod.json settings: ${problem}`);
      // A limit of zero would empty the panel, so it falls back like a bad value.
      for (const key of Object.keys(settings.limits))
        if (!(settings.limits[key] > 0)) settings.limits[key] = DEFAULT_SETTINGS.limits[key];
      this.settings = settings;
      if (localStorage.getItem("view") === null && ["tree", "flat", "columns"].includes(settings.default.view))
        this.view = settings.default.view;
      if (
        this.mode === "sidebar" &&
        localStorage.getItem("diff-layout") === null &&
        ["inline", "split"].includes(settings.default.diff)
      ) {
        this.diffLayout = settings.default.diff;
        setShared("better-changes.diff-layout", this.diffLayout);
      }
      // A floor, so a bare number read as milliseconds cannot spin Git.
      cx.timer.every(Math.max(1000, duration(settings.refresh.status, STATUS_POLL_MS)), (cx) =>
        this.refresh(cx),
      );
      cx.notify();
    });
  }

  // `better-changes.<command>`, for keys.
  command(command, cx) {
    if (command === "refresh") this.refreshAll(cx);
    if (command === "generate") this.generateMessage(cx); // VNH: ⌥S (keys.json), the ✨ button
    if (command === "session-only") this.setSessionOnly(!this.sessionOnly, cx);
    if (command === "changes" || command === "commit" || command === "pr") this.setTab(command, cx);
    if (command === "flat" || command === "tree" || command === "columns") this.setView(command, cx);
    if (command === "inline" || command === "split") this.setDiffLayout(command, cx);
    if (command.startsWith("undo:")) this.undoRollback(command.slice(5), cx); // the notice of a Rollback (vnh-changes-menu)
    if (command.startsWith("open:")) {
      const file = this.files.find((f) => f.path === command.slice(5));
      if (file)
        this.pick(file, file.conflict ? "conflict" : file.unstaged ? "unstaged" : "staged", cx);
    }
  }

  // VNH: puts back what a Rollback saved (vnh-changes-menu keeps it in ~/.cache/vnh-changes-undo/<id>/): the staged changes with the
  // index, the worktree's changes, the untracked files it deleted. Only the panel that shows that repository does it.
  async undoRollback(id, cx) {
    if (!/^[0-9a-z]+$/.test(id) || !this.root) return;
    const B = `${home()}/.cache/vnh-changes-undo/${id}`;
    const r = await exec("sh", ["-c", 'cat "$1/manifest.json"', "x", B]).catch(() => null);
    let m = null; try { m = JSON.parse(r?.stdout ?? ""); } catch {}
    if (!m || m.root !== this.root) { notify({ title: "Can't undo", body: m ? "It was another repository." : "What it saved is gone.", level: "warning", timeout: 5000 }); return; }
    if (m.type === "reset") {
      // HEAD goes back where it was (hard: with the working tree, kept as a stash commit); untracked files were never touched.
      const steps = [`git reset --${m.mode === "hard" ? "hard" : m.mode} ${m.head}`];
      if (m.stash) steps.push(`git stash apply --index ${m.stash}`);
      const res = await exec("sh", ["-c", steps.join(" && "), "x"], { cwd: this.root }).catch(() => null);
      if (res?.code === 0) { setShared("better-changes.reload", { root: this.root, on: null, at: Date.now() }); notify({ title: "Reset undone", body: m.head.slice(0, 8), level: "success", timeout: 4000 }); }
      else notify({ title: "Couldn't undo the reset", body: (res?.stderr || "").trim().slice(0, 200), level: "error", timeout: 7000 });
      return;
    }
    const steps = [];
    if (m.staged?.length) steps.push('git apply --index "$1/staged.patch"');
    if (m.work?.length) steps.push('[ -s "$1/work.patch" ] && git apply "$1/work.patch" || true');
    for (const p of m.copies ?? []) steps.push(`mkdir -p "$(dirname -- ${JSON.stringify(p)})" && cp -p "$1/files/"${JSON.stringify(p)} ${JSON.stringify(p)}`);
    const res = await exec("sh", ["-c", steps.length ? steps.join(" && ") : "true", "x", B], { cwd: this.root }).catch(() => null);
    if (res?.code === 0) {
      setShared("better-changes.reload", { root: this.root, on: null, at: Date.now() });
      notify({ title: "Rollback undone", body: `${m.work?.length || m.copies?.length || 0} file(s) are back`, level: "success", timeout: 4000 });
    } else notify({ title: "Couldn't undo", body: (res?.stderr || "").trim().slice(0, 200) || "git apply failed (the files changed since?)", level: "error", timeout: 7000 });
  }

  // The Claude / agy session(s) of the agent in the focused pane (with a shell focused: of the agents of its tab), from the status files.
  async readMine(cx) {
    const f = focused();
    if (!f?.tab) return;
    const fp = f.pane ? panes().find((p) => p.pane === f.pane) : null;
    const terms = fp?.status && fp.terminal ? [fp.terminal] : agents().filter((a) => a.tab === f.tab).map((a) => a.address);
    this.mineTerms = terms;
    const key = terms.join(","), now = Date.now();
    if (key === this.mineKey && now - this.mineAt < 4000) return;
    this.mineKey = key; this.mineAt = now;
    // A status file is rewritten by the agent all the time: a read that catches it half written, or without the session for a moment,
    // keeps the session last seen for that terminal (so the list doesn't flash empty); a new session replaces it.
    this.lastSession ??= new Map();
    const sessions = [];
    for (const t of terms) {
      const text = await readTextFile(`${home()}/.cache/herdr-status/${t}.json`).catch(() => null);
      try { const id = JSON.parse(text ?? "{}").session; if (id) this.lastSession.set(t, id); } catch {}
      if (this.lastSession.has(t)) sessions.push(this.lastSession.get(t));
    }
    // An agent is in view but has no session yet (just started): it has written nothing, so the list is empty. No agent at all: no filter.
    const next = sessions.length ? sessions : terms.length ? [] : null;
    if (next?.join() !== this.mine?.join() || Boolean(next) !== Boolean(this.mine)) { this.mine = next; this.sessionKey = ""; cx.notify(); } // the old set stays until the new one is read: no flash
  }

  // ── The panel's state, kept per tab (each agent / shell tab has its own) ──────────────────────────────────────────────
  // Which sub-tab (Changes / Commits / PRs / Stashes), the session filter, the PR filter, the open PR and the open commit.
  // Saved in localStorage under the id of the tab in view whenever one of them changes, put back when that tab is shown again.
  uiStore() { try { return JSON.parse(localStorage.getItem("vnh-ui-by-tab") ?? "{}"); } catch { return {}; } }

  saveUi() {
    if (this.mode !== "sidebar" || !this.uiKey) return;
    const all = this.uiStore();
    all[this.uiKey] = { tab: this.tab, only: Boolean(this.sessionOnly), prf: this.prFilter ?? "all", pr: this.selectedPr?.number ?? this.pendingPr ?? null, commit: this.selectedCommit?.hash ?? this.pendingCommit ?? null, at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > 80) for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 80)) delete all[k];
    try { localStorage.setItem("vnh-ui-by-tab", JSON.stringify(all)); } catch {}
  }

  // The tab in view changed: show its own state (a tab never seen keeps what is shown now, and starts from there).
  applyUi(key, cx) {
    const st = this.uiStore()[key];
    this.uiKey = key;
    if (!st) { this.saveUi(); return; }
    this.tab = ["changes", "commit", "pr", "stash"].includes(st.tab) ? st.tab : "changes";
    this.sessionOnly = Boolean(st.only);
    this.prFilter = st.prf ?? "all";
    this.selectedPr = null; this.prDetail = null; this.prCode = null; this.prToken = (this.prToken ?? 0) + 1;
    this.selectedCommit = null; this.commitToken = (this.commitToken ?? 0) + 1;
    this.pendingPr = st.pr ?? null; this.pendingCommit = st.commit ?? null; this.pendingAt = Date.now();
    localStorage.setItem("tab", this.tab);
    if (this.tab === "commit") this.loadCommits(cx);
    if (this.tab === "pr") { this.loadPulls(cx); if (this.prFilter === "done") this.loadDone(cx); }
    this.resolvePending(cx);
    cx.notify();
  }

  // The open PR / commit of a saved state is opened once its list is there (they are read a moment after the switch).
  resolvePending(cx) {
    if (!this.pendingPr && !this.pendingCommit) return;
    if (Date.now() - this.pendingAt > 20000) { this.pendingPr = this.pendingCommit = null; return; }
    if (this.pendingPr && this.tab === "pr") {
      const pr = [...(this.prs ?? []), this.prBranch, ...(this.prsDone ?? [])].find((p) => p && p.number === this.pendingPr);
      if (pr) { this.pendingPr = null; this.openPr(pr, cx); }
    }
    if (this.pendingCommit && this.tab === "commit") {
      const c = this.commits.find((x) => x.hash === this.pendingCommit);
      if (c) { this.pendingCommit = null; this.openCommit(c, cx); }
    }
  }

  // Asks SESSION_PY, at most every 6 s and when the session or the number of changed files changed.
  readSessionFiles(cx) {
    if (this.sessionBusy || !this.root || this.on || !this.mine) return;
    const key = `${this.mine.join()}|${this.files.length}`, now = Date.now();
    if (key === this.sessionKey && now - (this.sessionAt ?? 0) < 6000) return;
    this.sessionKey = key; this.sessionAt = now; this.sessionBusy = true;
    const { root, context } = this;
    exec("python3", ["-I", "-c", SESSION_PY, ...this.mine.map((x) => `s:${x}`), ...(this.mineTerms ?? []).map((x) => `t:${x}`)], { cwd: root, timeout: 30000 })
      .then((r) => {
        if (r.code !== 0 || !this.isCurrent(context)) return;
        const out = JSON.parse(r.stdout.trim().split("\n").pop());
        const next = new Set(out.paths), same = this.sessionSet && next.size === this.sessionSet.size && [...next].every((p) => this.sessionSet.has(p));
        if (!same) { this.sessionSet = next; cx.notify(); }
      })
      .catch(() => {})
      .finally(() => { this.sessionBusy = false; });
  }

  follow(cx) {
    if (this.mode === "sidebar") {
      const tab = focused()?.tab; // the Changes panel itself has no tab: it keeps the last one
      if (tab && tab !== this.uiKey) this.applyUi(tab, cx);
      this.resolvePending(cx);
    }
    if (this.mode === "sidebar" && this.sessionOnly && this.tab === "changes") { this.readMine(cx).catch(() => {}); this.readSessionFiles(cx); }
    const style = shared("better-changes.diff-layout");
    if (style && style !== this.diffLayout) {
      this.diffLayout = style;
      localStorage.setItem("diff-layout", style);
      cx.notify();
    }
    if (this.contextKey() !== this.context) this.refresh(cx);
    if (this.mode === "sidebar") {
      const seen = shared("better-changes.prs");
      if (seen && seen !== this.prSeen) { this.prSeen = seen; this.prsAt = 0; if (this.tab === "pr") this.loadPulls(cx, true); }
      else if (this.tab === "pr" && this.root) this.loadPulls(cx);
    }
    if (this.mode === "diff") {
      this.syncSelection(cx);
      if (this.root && this.path && this.shownFull !== this.fullFile()) this.loadDiff(cx);
      this.publishHead();
    }
    const reload = shared("better-changes.reload");
    if (
      reload &&
      reload.at !== this.reload &&
      reload.root === this.root &&
      reload.on === (this.on ?? null) &&
      !this.loading &&
      !this.busy
    ) {
      this.reload = reload.at;
      this.refresh(cx);
    }
  }
}

Object.assign(BetterChanges.prototype, gitMethods, sidebarMethods, diffMethods, paneHeaderMethods, pullsMethods);

export default BetterChanges;

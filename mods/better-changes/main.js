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
import { props, shared, setShared, nextCommand, layout, run, notify, closeOverlay, exec, home } from "herdr";
import { loadSettings, duration } from "./settings.js";
import { followFileIcons } from "./file-icons.js";
import { panelCommands } from "./panel.js";
import { gitMethods } from "./git/repository.js";
import { sidebarMethods } from "./views/sidebar.js";
import { diffMethods } from "./views/diff.js";
import { paneHeaderMethods } from "./views/pane-header.js";
import { pullsMethods } from "./views/pulls.js";

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

  follow(cx) {
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

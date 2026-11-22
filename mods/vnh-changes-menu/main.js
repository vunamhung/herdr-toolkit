// The right-click menu of a file or a folder in the Changes panel (opened by better-changes as a popup).
//   Working changes: Rollback…, Delete…, Stage, Unstage (greyed where they don't apply), then Send to agent, Copy path,
//   Copy relative path, Open file, Reveal. A committed file or folder has only the last group: nothing there rewrites a commit.
// A folder acts on every file under it that the panel lists in that group.
// Safety: Delete moves to the Trash. Rollback first saves what it discards under ~/.cache/vnh-changes-undo/<id>/ (patches of the
// staged and unstaged changes, a copy of the untracked files it deletes) and says so in a notice whose action undoes it
// (`better-changes.undo:<id>`, handled by better-changes). On another machine (`on`) neither safety net exists and the question says so.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, exec, setShared, notify, window, home, focused, panes, agents, run } from "herdr";

const ICON = (n) => `mods/vnh-changes-menu/${n}.svg`;
const UNDO_DIR = () => `${home()}/.cache/vnh-changes-undo`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// What Rollback does to a file listed in `scope` with status letter `status` (A: new, D: deleted, M: changed).
function kindOf(scope, status) {
  if (scope === "unstaged") return status === "A" ? "untracked" : "unstaged";
  if (scope === "staged") return status === "A" ? "stagedNew" : "staged";
  return null;
}

// "@path " typed into the agent of the shown tab, through the clipboard, which is put back afterwards.
function sendToAgent(cx, abs, done) {
  const f = focused(), fp = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const inTab = agents().filter((a) => a.tab === f?.tab);
  const address = (fp?.status && fp.terminal) || (inTab.find((a) => a.focused) ?? inTab[0])?.address || agents().find((a) => a.focused)?.address;
  if (!address) { notify({ title: "No agent in this tab", body: "Start one, then send the path again", level: "warning", timeout: 3000 }); done(); return; }
  const cwd = (panes().find((p) => p.terminal === address)?.cwd ?? "").replace(/\/+$/, "");
  const path = cwd && abs.startsWith(cwd + "/") ? abs.slice(cwd.length + 1) : abs;
  const text = `@${/\s/.test(path) ? `"${path}"` : path} `;
  const before = cx.read_from_clipboard();
  cx.write_to_clipboard(text);
  run("pane.focus", { terminal: address });
  run("terminal.paste");
  cx.timer.after(600, (cx) => { if (before !== undefined) cx.write_to_clipboard(before); done(); });
}

export default class ChangesMenu extends View {
  init(_props, cx) {
    this.ask = null; // "rollback" | "delete" once chosen: the question before it runs
    this.busy = false;
  }

  a() { return props() ?? {}; }
  close() { closeOverlay(props()?.overlay); }

  abs(path) { return `${String(this.a().root ?? "").replace(/\/+$/, "")}/${path}`; }

  async sh(script, args) {
    const { root, on } = this.a();
    return exec("sh", ["-c", script, "x", root, ...args], { cwd: root, on: on ?? null });
  }

  async git(args) {
    const { root, on } = this.a();
    const r = await exec("git", args, { cwd: root, on: on ?? null });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim() || `git ${args[0]} failed`);
    return r;
  }

  done(label, cx, then) {
    const { root, on } = this.a();
    setShared("better-changes.reload", { root, on: on ?? null, at: Date.now() });
    if (then) then();
    this.close();
  }

  fail(label, e) {
    notify({ title: `${label} failed`, body: String(e?.message ?? e).slice(0, 220), level: "error", timeout: 7000 });
    this.close();
  }

  async stage(label, args, cx) {
    const { paths } = this.a();
    this.busy = true; cx.notify();
    try { await this.git([...args, "--", ...paths]); this.done(label, cx); } catch (e) { this.fail(label, e); }
  }

  // Delete: into the Trash (macOS ~/.Trash, Linux gio / the trash folder); on another machine, or where nothing can, gone for good.
  async remove(cx) {
    const { paths, on } = this.a();
    this.busy = true; cx.notify();
    const os = window()?.platform;
    try {
      let script;
      if (on) script = 'cd "$1"; shift; rm -rf -- "$@"';
      else if (os === "macos") script = 'cd "$1"; shift; T="$HOME/.Trash"; mkdir -p "$T"; for p in "$@"; do b=$(basename "$p"); d="$T/$b"; [ -e "$d" ] && d="$T/$b.$(date +%H%M%S).$$"; mv -- "$p" "$d" || exit 1; done';
      else script = 'cd "$1"; shift; for p in "$@"; do (command -v gio >/dev/null 2>&1 && gio trash -- "$p") || rm -rf -- "$p"; done';
      const r = await this.sh(script, paths);
      if (r.code !== 0) throw new Error((r.stderr || "").trim() || "could not remove");
      this.done("Delete", cx, () => notify({ title: on ? "Deleted" : "Moved to the Trash", body: paths.length === 1 ? paths[0] : plural(paths.length, "file"), level: "info", timeout: 4000 }));
    } catch (e) { this.fail("Delete", e); }
  }

  // Rollback, after saving what it discards.
  async rollback(cx) {
    const { paths, statuses, scope, root, on } = this.a();
    this.busy = true; cx.notify();
    try {
      const by = { unstaged: [], staged: [], stagedNew: [], untracked: [] };
      for (const p of paths) { const k = kindOf(scope, statuses?.[p]); if (k) by[k].push(p); }
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const B = `${UNDO_DIR()}/${id}`;
      const manifest = { id, root, at: Date.now(), staged: [...by.staged, ...by.stagedNew], work: [...by.unstaged, ...by.staged, ...by.stagedNew], copies: by.untracked };
      if (!on) {
        // What goes: the staged changes (scope staged) and the worktree's, as patches; untracked files, copied.
        await this.sh('B="$2"; shift 2; mkdir -p "$B/files"', [B]);
        if (manifest.staged.length) await this.sh('B="$2"; shift 2; git diff --cached --binary -- "$@" > "$B/staged.patch"', [B, ...manifest.staged]);
        if (manifest.work.length) await this.sh('B="$2"; shift 2; git diff --binary -- "$@" > "$B/work.patch"', [B, ...manifest.work]);
        if (by.untracked.length) await this.sh('B="$2"; shift 2; for p in "$@"; do mkdir -p "$B/files/$(dirname "$p")" && cp -p "$p" "$B/files/$p"; done', [B, ...by.untracked]);
        await this.sh('B="$2"; printf "%s" "$3" > "$B/manifest.json"', [B, JSON.stringify(manifest)]);
        await this.sh('ls -1t "$HOME/.cache/vnh-changes-undo" | tail -n +21 | while read d; do rm -rf "$HOME/.cache/vnh-changes-undo/$d"; done; true', []);
      }
      if (by.unstaged.length) await this.git(["restore", "--", ...by.unstaged]);
      if (by.staged.length) await this.git(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...by.staged]);
      if (by.stagedNew.length) await this.git(["rm", "-f", "-q", "--", ...by.stagedNew]);
      if (by.untracked.length) await this.git(["clean", "-f", "-q", "--", ...by.untracked]);
      const n = paths.length;
      this.done("Rollback", cx, () => notify({
        title: `Rolled back ${plural(n, "file")}`,
        body: on ? "On another machine: this can't be undone." : "Click to undo.",
        level: "info", timeout: 20000,
        ...(on ? {} : { action: { name: `better-changes.undo:${id}` } }),
      }));
    } catch (e) { this.fail("Rollback", e); }
  }

  render() {
    const t = theme(), { kind, name, scope, paths = [], statuses, on } = this.a();
    const n = paths.length, one = n === 1, path = paths[0] ?? "";
    const isFolder = kind === "folder", what = isFolder ? `${name}/ (${plural(n, "file")})` : name;
    const os = window()?.platform;
    const kinds = new Set(paths.map((p) => kindOf(scope, statuses?.[p])).filter(Boolean));
    const working = scope === "unstaged" || scope === "staged" || scope === "conflict";
    const canRollback = kinds.size > 0, canDelete = working && n > 0;
    const canStage = scope === "unstaged" && n > 0, canUnstage = scope === "staged" && n > 0;
    const absPath = isFolder ? this.abs(name === "." ? "" : this.a().dir ?? name).replace(/\/$/, "") : this.abs(path);
    const item = (id, icon, label, enabled, action) => h_flex().id(`cm-${id}`).h(30).px(10).gap(10).items_center().rounded(7)
      .text_size(13).text_color(enabled ? t.foreground : t.dim).opacity(enabled ? 1 : 0.5)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { if (!this.busy) action(cx); }))
      .child(svg(ICON(icon)).size(14).flex_none().text_color(enabled ? t.muted : t.dim))
      .child(div().flex_1().child(label));
    const line = () => div().h(1).my(4).mx(4).bg(t.border);
    const copy = (text, label) => (cx) => { cx.write_to_clipboard(text); notify({ title: `Copied the ${label}`, body: text, level: "info", timeout: 2000 }); this.close(); };
    const open = async () => {
      if (os === "windows") await exec("cmd", ["/c", "start", "", absPath], { on: on ?? null }).catch(() => null);
      else await exec(os === "linux" ? "xdg-open" : "open", [absPath], { on: on ?? null }).catch(() => null);
      this.close();
    };
    const reveal = async () => {
      if (os === "windows") await exec("explorer", [`/select,${absPath.replace(/\//g, "\\")}`], { on: on ?? null }).catch(() => null);
      else if (os === "linux") await exec("xdg-open", [isFolder ? absPath : absPath.replace(/\/[^/]*$/, "")], { on: on ?? null }).catch(() => null);
      else await exec("open", [isFolder ? absPath : "-R", ...(isFolder ? [] : [absPath])], { on: on ?? null }).catch(() => null);
      this.close();
    };
    const paths_ = [
      item("send", "at", "Send to agent (@path)", !on, (cx) => { this.busy = true; sendToAgent(cx, absPath, () => this.close()); }),
      item("copy-path", "copy", "Copy path", true, copy(absPath, "path")),
      item("copy-rel", "copy", "Copy relative path", true, copy(isFolder ? (this.a().dir ?? name) : path, "relative path")),
      ...(isFolder ? [] : [item("open", "file", "Open file", !on, () => open())]),
      item("reveal", "folder", on ? "Reveal (not on another machine)" : os === "macos" ? (isFolder ? "Open the folder" : "Reveal in Finder") : "Show in the file manager", !on, () => reveal()),
    ];

    if (this.ask) {
      const rb = this.ask === "rollback";
      const text = rb ? `Roll back ${what}?` : `${on ? "Delete" : "Move to the Trash:"} ${what}${on ? " from the disk?" : "?"}`;
      const note = rb
        ? (on ? "This can't be undone (another machine)." : "What it discards is saved; the notice afterwards undoes it.")
        : (on ? "This can't be undone (another machine)." : "You can put it back from the Trash.");
      return v_flex().id("cm-ask").w_full().p(10).gap(10).bg(t.popover).text_size(13)
        .child(div().text_color(t.foreground).child(text))
        .child(div().text_size(11.5).text_color(t.dim).child(note))
        .child(h_flex().gap(8).justify_end()
          .child(div().id("cm-cancel").h(28).px(12).flex().items_center().rounded(7).cursor_pointer().text_color(t.muted)
            .hover((s) => s.bg(t.hover)).on_click(() => this.close()).child("Cancel"))
          .child(div().id("cm-go").h(28).px(12).flex().items_center().rounded(7).cursor_pointer().bg(t.blocked + "33").text_color(t.blocked)
            .hover((s) => s.bg(t.blocked + "4d")).on_click((_e, cx) => { if (this.busy) return; rb ? this.rollback(cx) : this.remove(cx); }).child(rb ? "Rollback" : on ? "Delete" : "Move to the Trash")));
    }
    return v_flex().id("cm").w_full().p(5).gap(1).bg(t.popover)
      .when(working, (el) => el
        .child(item("rollback", "undo", "Rollback…", canRollback, (cx) => { this.ask = "rollback"; cx.notify(); }))
        .child(item("delete", "trash", "Delete…", canDelete, (cx) => { this.ask = "delete"; cx.notify(); }))
        .child(line())
        .child(item("stage", "plus", isFolder ? "Stage all in the folder" : "Stage", canStage, (cx) => this.stage("Stage", ["add"], cx)))
        .child(item("unstage", "minus", isFolder ? "Unstage all in the folder" : "Unstage", canUnstage, (cx) => this.stage("Unstage", ["restore", "--staged"], cx)))
        .child(line()))
      .children(paths_);
  }
}

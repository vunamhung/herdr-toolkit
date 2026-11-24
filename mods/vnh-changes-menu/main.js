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
import { commitItems, commitAsk, startPrompt, promptView } from "./commit.js";
import { prItems, prAsk, agentText } from "./pr.js";

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
  typeIntoAgent(cx, `@${/\s/.test(path) ? `"${path}"` : path} `, done, address);
}

// `text` typed into the agent of the shown tab (or `address`), through the clipboard, which is put back afterwards.
function typeIntoAgent(cx, text, done, given) {
  const f = focused(), fp = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const inTab = agents().filter((a) => a.tab === f?.tab);
  const address = given ?? ((fp?.status && fp.terminal) || (inTab.find((a) => a.focused) ?? inTab[0])?.address || agents().find((a) => a.focused)?.address);
  if (!address) { notify({ title: "No agent in this tab", body: "Start one, then try again", level: "warning", timeout: 3000 }); done(); return; }
  const before = cx.read_from_clipboard();
  cx.write_to_clipboard(text);
  run("pane.focus", { terminal: address });
  run("terminal.paste");
  cx.timer.after(600, (cx) => { if (before !== undefined) cx.write_to_clipboard(before); done(); });
}

export default class ChangesMenu extends View {
  init(_props, cx) {
    this.ask = props()?.ask ?? null; // "rollback" | "delete" once chosen: the question before it runs
    this.busy = false;
    // The question's main button is the default: the popup has the keyboard, so Enter presses it (Esc closes).
    this.handle = cx.focus_handle();
    cx.timer.after(50, () => this.handle.focus());
    // A pull request's quick action ("Fix with agent", "Review with agent") runs at once and closes.
    const auto = props()?.kind === "pr" ? props()?.auto : null;
    if (auto) { this.busy = true; cx.timer.after(40, (cx) => typeIntoAgent(cx, agentText(auto, props()), () => this.close())); }
  }

  a() { return props() ?? {}; }
  enter(e, cx, go) {
    const m = e.modifiers ?? {};
    if (e.key !== "enter" || m.control || m.alt || m.platform || m.shift) return;
    cx.stop_propagation();
    if (!this.busy) go(cx);
  }
  typeIntoAgent(cx, text, done) { typeIntoAgent(cx, text, done); }
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
    setShared("better-changes.prs", Date.now()); // the PRs tab reads again
    if (then) then();
    this.close();
  }

  // A commit action: `fn` runs (git), then the panel reloads and a notice says it went well.
  async runOps(name, fn, cx, ok) {
    this.busy = true; cx.notify();
    try { await fn(); this.done(name, cx, () => notify({ title: ok ?? `${name} done`, level: "success", timeout: 3500 })); } catch (e) { this.fail(name, e); }
  }

  // A git command that may stop on a conflict: then its own abort puts everything back.
  async tryAbort(args, abortArgs) {
    const { root, on } = this.a();
    const r = await exec("git", args, { cwd: root, on: on ?? null });
    if (r.code === 0) return r;
    await exec("git", abortArgs, { cwd: root, on: on ?? null }).catch(() => null);
    throw new Error(`It conflicts, so it was aborted and nothing changed.\n${(r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" ")}`);
  }

  startPrompt() { startPrompt(this); }

  async submitPrompt(cx) {
    const name = String(this.input?.value() ?? "").trim(), { hash, root } = this.a();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(name) || name.includes("..")) { notify({ title: "Not a usable name", body: "Letters, digits, . _ - /", level: "warning", timeout: 3500 }); return; }
    if (this.busy) return;
    if (this.ask === "branch") return this.runOps("New branch", () => this.git(["switch", "-c", name, hash]), cx, `On ${name}`);
    const parent = String(root).replace(/\/+$/, "").replace(/\/[^/]*$/, ""), dir = `${parent}/${name.replace(/\//g, "-")}`;
    return this.runOps("New worktree", async () => { await this.git(["worktree", "add", "-b", name, dir, hash]); run("space.new", { name, folder: dir }); }, cx, `Worktree ${name} created`);
  }

  // Reset to `target` (a commit, or HEAD~1), after saving HEAD (and for hard: the working tree as a stash commit).
  async reset(mode, cx, target = this.a().hash, label = "Reset") {
    const { root, on } = this.a();
    this.busy = true; cx.notify();
    try {
      const head = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
      let stash = "";
      if (mode === "hard") stash = (await exec("git", ["stash", "create"], { cwd: root, on: on ?? null }).catch(() => ({ stdout: "" }))).stdout.trim();
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      if (!on) await this.sh('B="$2"; mkdir -p "$B"; printf "%s" "$3" > "$B/manifest.json"', [`${home()}/.cache/vnh-changes-undo/${id}`, JSON.stringify({ type: "reset", id, root, at: Date.now(), head, mode, stash })]);
      await this.git(["reset", `--${mode}`, target]);
      this.done(label, cx, () => notify({ title: `${label} done`, body: on ? "On another machine: this can't be undone." : "Click to undo.", level: "info", timeout: 20000, ...(on ? {} : { action: { name: `better-changes.undo:${id}` } }) }));
    } catch (e) { this.fail(label, e); }
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

  renderStashMenu(t) {
    const { ref, message } = this.a();
    const item = (id, icon, label, enabled, action) => h_flex().id(`cm-${id}`).h(30).px(10).gap(10).items_center().rounded(7)
      .text_size(13).text_color(enabled ? t.foreground : t.dim).opacity(enabled ? 1 : 0.5)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { if (!this.busy) action(cx); }))
      .child(svg(ICON(icon)).size(14).flex_none().text_color(enabled ? t.muted : t.dim))
      .child(div().flex_1().child(label));
    if (this.ask === "drop") {
      return v_flex().id("cm-ask").track_focus(this.handle).on_key_down((e, cx) => this.enter(e, cx, (cx) => this.runOps("Drop", () => this.git(["stash", "drop", ref]), cx, "Stash dropped")))
        .w_full().p(10).gap(10).bg(t.popover).text_size(13)
        .child(div().text_color(t.foreground).child(`Drop ${ref}?`))
        .child(div().text_size(11.5).text_color(t.dim).child(`${String(message).slice(0, 80)} — it is gone for good.`))
        .child(h_flex().gap(8).justify_end()
          .child(div().id("cm-cancel").h(28).px(12).flex().items_center().rounded(7).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover)).on_click(() => this.close()).child("Cancel"))
          .child(div().id("cm-go").h(28).px(12).border_1().border_color(t.foreground + "55").flex().items_center().rounded(7).cursor_pointer().bg(t.blocked + "33").text_color(t.blocked).hover((s) => s.bg(t.blocked + "4d"))
            .on_click((_e, cx) => { if (!this.busy) this.runOps("Drop", () => this.git(["stash", "drop", ref]), cx, "Stash dropped"); }).child("Drop")));
    }
    return v_flex().id("cm").track_focus(this.handle).w_full().p(5).gap(1).bg(t.popover)
      .child(item("apply", "plus", "Apply (keep the stash)", true, (cx) => this.runOps("Apply", () => this.git(["stash", "apply", "--index", ref]), cx, "Stash applied")))
      .child(item("pop", "undo", "Pop (apply and remove)", true, (cx) => this.runOps("Pop", () => this.git(["stash", "pop", "--index", ref]), cx, "Stash popped")))
      .child(item("drop", "trash", "Drop…", true, (cx) => { this.ask = "drop"; cx.notify(); }))
      .child(div().h(1).my(4).mx(4).bg(t.border))
      .child(item("copy", "copy", "Copy message", true, (cx) => { cx.write_to_clipboard(String(message)); notify({ title: "Copied the message", level: "info", timeout: 2000 }); this.close(); }));
  }

  renderCommitMenu(t) {
    const item = (id, icon, label, enabled, action) => h_flex().id(`cm-${id}`).h(30).px(10).gap(10).items_center().rounded(7)
      .text_size(13).text_color(enabled ? t.foreground : t.dim).opacity(enabled ? 1 : 0.5)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { if (!this.busy) action(cx); }))
      .child(svg(ICON(icon)).size(14).flex_none().text_color(enabled ? t.muted : t.dim))
      .child(div().flex_1().child(label));
    const line = () => div().h(1).my(4).mx(4).bg(t.border);
    if (this.ask === "branch" || this.ask === "worktree") return promptView(this, t);
    const q = this.ask ? commitAsk(this) : null;
    if (q) {
      return v_flex().id("cm-ask").track_focus(this.handle).on_key_down((e, cx) => this.enter(e, cx, q.go))
        .w_full().p(10).gap(10).bg(t.popover).text_size(13)
        .child(div().text_color(t.foreground).child(q.title))
        .child(div().text_size(11.5).text_color(t.dim).child(q.note))
        .child(h_flex().gap(8).justify_end()
          .child(div().id("cm-cancel").h(28).px(12).flex().items_center().rounded(7).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover)).on_click(() => this.close()).child("Cancel"))
          .child(div().id("cm-go").h(28).px(12).border_1().border_color(t.foreground + "55").flex().items_center().rounded(7).cursor_pointer().bg((q.danger ? t.blocked : t.accent) + "33").text_color(q.danger ? t.blocked : t.foreground)
            .hover((s) => s.bg((q.danger ? t.blocked : t.accent) + "4d")).on_click((_e, cx) => { if (!this.busy) q.go(cx); }).child("Do it")));
    }
    return v_flex().id("cm").w_full().p(5).gap(1).bg(t.popover).children(commitItems(this, t, item, line));
  }

  renderPrMenu(t) {
    const item = (id, icon, label, enabled, action) => h_flex().id(`cm-${id}`).h(30).px(10).gap(10).items_center().rounded(7)
      .text_size(13).text_color(enabled ? t.foreground : t.dim).opacity(enabled ? 1 : 0.5)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { if (!this.busy) action(cx); }))
      .child(svg(ICON(icon)).size(14).flex_none().text_color(enabled ? t.muted : t.dim))
      .child(div().flex_1().child(label));
    const line = () => div().h(1).my(4).mx(4).bg(t.border);
    const q = this.ask ? prAsk(this) : null;
    if (this.busy && this.a().auto) return v_flex().id("cm-auto").w_full().p(12).bg(t.popover).text_size(13).text_color(t.muted).child("Sending to the agent…");
    if (q) {
      return v_flex().id("cm-ask").track_focus(this.handle).on_key_down((e, cx) => this.enter(e, cx, q.go))
        .w_full().p(10).gap(10).bg(t.popover).text_size(13)
        .child(div().text_color(t.foreground).whitespace_normal().child(q.title))
        .child(div().text_size(11.5).text_color(t.dim).whitespace_normal().child(q.note))
        .child(h_flex().gap(8).justify_end()
          .child(div().id("cm-cancel").h(28).px(12).flex().items_center().rounded(7).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover)).on_click(() => this.close()).child("Cancel"))
          .child(div().id("cm-go").h(28).px(12).border_1().border_color(t.foreground + "55").flex().items_center().rounded(7).cursor_pointer().bg((q.danger ? t.blocked : t.accent) + "33").text_color(q.danger ? t.blocked : t.foreground)
            .hover((s) => s.bg((q.danger ? t.blocked : t.accent) + "4d")).on_click((_e, cx) => { if (!this.busy) q.go(cx); }).child(this.busy ? "Working…" : "Do it")));
    }
    return v_flex().id("cm").w_full().p(5).gap(1).bg(t.popover).children(prItems(this, t, item, line));
  }

  render() {
    const t = theme(), { kind, name, scope, paths = [], statuses, on } = this.a();
    if (kind === "pr") return this.renderPrMenu(t);
    if (kind === "commit") return this.renderCommitMenu(t);
    if (kind === "stash") return this.renderStashMenu(t);
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
    const stashFiles = (cx) => this.runOps("Stash", () => this.git(["stash", "push", "--include-untracked", "-m", `${name} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, "--", ...paths]), cx, "Stashed: see the Stashes tab");
    const ours = (side) => (cx) => this.runOps(side === "ours" ? "Accept ours" : "Accept theirs", async () => { await this.git(["checkout", `--${side}`, "--", ...paths]); await this.git(["add", "--", ...paths]); }, cx, side === "ours" ? "Kept our side" : "Took their side");
    // A folder is ignored as the folder ("/dir/"), not file by file; an entry already there is not added twice.
    const ignoreLines = isFolder && this.a().dir && this.a().dir !== "." ? [`/${this.a().dir}/`] : paths.map((p) => `/${p}`);
    const ignore = (cx) => this.runOps("Ignore", () => this.sh('cd "$1"; shift; [ -s .gitignore ] && [ -n "$(tail -c1 .gitignore)" ] && echo >> .gitignore; for p in "$@"; do grep -qxF -- "$p" .gitignore 2>/dev/null || printf "%s\\n" "$p" >> .gitignore; done', ignoreLines), cx, "Added to .gitignore");
    const historyOf = () => { run("tab.new", { folder: this.a().root, name: `history ${name}`.slice(0, 40), argv: ["sh", "-lc", `git log --follow --stat --color=always -- ${JSON.stringify(isFolder ? this.a().dir : path)} | less -R`] }); this.close(); };
    const blameOf = () => { run("tab.new", { folder: this.a().root, name: `blame ${name}`.slice(0, 40), argv: ["sh", "-lc", `git blame --color-lines -- ${JSON.stringify(path)} | less -R`] }); this.close(); };
    const paths_ = [
      item("send", "at", "Send to agent (@path)", !on, (cx) => { this.busy = true; sendToAgent(cx, absPath, () => this.close()); }),
      item("copy-path", "copy", "Copy path", true, copy(absPath, "path")),
      item("copy-rel", "copy", "Copy relative path", true, copy(isFolder ? (this.a().dir ?? name) : path, "relative path")),
      ...(isFolder ? [] : [item("open", "file", "Open file", !on, () => open())]),
      item("history", "history", isFolder ? "History of the folder" : "History of the file", !on, () => historyOf()),
      ...(isFolder ? [] : [item("blame", "blame", "Blame (who changed each line)", !on && scope !== "untracked", () => blameOf())]),
      item("reveal", "folder", on ? "Reveal (not on another machine)" : os === "macos" ? (isFolder ? "Open the folder" : "Reveal in Finder") : "Show in the file manager", !on, () => reveal()),
    ];

    if (this.ask) {
      const rb = this.ask === "rollback";
      const text = rb ? `Roll back ${what}?` : `${on ? "Delete" : "Move to the Trash:"} ${what}${on ? " from the disk?" : "?"}`;
      const note = rb
        ? (on ? "This can't be undone (another machine)." : "What it discards is saved; the notice afterwards undoes it.")
        : (on ? "This can't be undone (another machine)." : "You can put it back from the Trash.");
      return v_flex().id("cm-ask").track_focus(this.handle).on_key_down((e, cx) => this.enter(e, cx, (cx) => (rb ? this.rollback(cx) : this.remove(cx))))
        .w_full().p(10).gap(10).bg(t.popover).text_size(13)
        .child(div().text_color(t.foreground).child(text))
        .child(div().text_size(11.5).text_color(t.dim).child(note))
        .child(h_flex().gap(8).justify_end()
          .child(div().id("cm-cancel").h(28).px(12).flex().items_center().rounded(7).cursor_pointer().text_color(t.muted)
            .hover((s) => s.bg(t.hover)).on_click(() => this.close()).child("Cancel"))
          .child(div().id("cm-go").h(28).px(12).border_1().border_color(t.foreground + "55").flex().items_center().rounded(7).cursor_pointer().bg(t.blocked + "33").text_color(t.blocked)
            .hover((s) => s.bg(t.blocked + "4d")).on_click((_e, cx) => { if (this.busy) return; rb ? this.rollback(cx) : this.remove(cx); }).child(rb ? "Rollback" : on ? "Delete" : "Move to the Trash")));
    }
    return v_flex().id("cm").w_full().p(5).gap(1).bg(t.popover)
      .when(working, (el) => el
        .child(item("rollback", "undo", "Rollback…", canRollback, (cx) => { this.ask = "rollback"; cx.notify(); }))
        .child(item("delete", "trash", "Delete…", canDelete, (cx) => { this.ask = "delete"; cx.notify(); }))
        .child(line())
        .child(item("stage", "plus", isFolder ? "Stage all in the folder" : "Stage", canStage, (cx) => this.stage("Stage", ["add"], cx)))
        .child(item("unstage", "minus", isFolder ? "Unstage all in the folder" : "Unstage", canUnstage, (cx) => this.stage("Unstage", ["restore", "--staged"], cx)))
        .child(item("stash", "stash", isFolder ? "Stash the folder…" : "Stash this file", n > 0, stashFiles))
        .child(line())
        .when(scope === "conflict", (c) => c.child(item("ours", "check", "Accept ours", n > 0, ours("ours"))).child(item("theirs", "check", "Accept theirs", n > 0, ours("theirs"))).child(line()))
        .when(scope === "unstaged" && [...kinds].includes("untracked"), (c) => c.child(item("ignore", "ignore", "Add to .gitignore", !on, ignore)).child(line())))
      .children(paths_);
  }
}

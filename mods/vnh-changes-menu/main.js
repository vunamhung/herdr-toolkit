// The right-click menu of a file in the Changes panel (opened by better-changes as a popup): Rollback…, Delete…, Stage, Unstage,
// the last two greyed where they don't apply. Rollback and Delete ask first. It runs git itself and then tells better-changes
// to reload (shared "better-changes.reload", as its own stage / unstage does).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, exec, setShared, notify } from "herdr";

const ICON = (n) => `mods/vnh-changes-menu/${n}.svg`;

// What "Rollback" does to this file, by where it is listed and its status letter (A: new, D: deleted, M: changed).
function rollbackPlan(scope, status, base) {
  // A committed file (in a commit the remote doesn't have): back to what the remote's branch has, as an uncommitted change.
  if (scope === "committed") {
    if (!base) return null;
    return status === "A"
      ? { what: `Delete this file, which ${base} doesn't have`, args: [["rm", "-f", "-q", "--"]] }
      : { what: `Restore this file to ${base}'s version (the difference becomes an uncommitted change)`, args: [["restore", `--source=${base}`, "--staged", "--worktree", "--"]] };
  }
  if (scope === "unstaged" && status === "A") return { what: "Delete this new, untracked file", args: [["clean", "-f", "-q", "--"]] };
  if (scope === "unstaged") return { what: "Discard the changes that aren't staged", args: [["restore", "--"]] };
  if (scope === "staged" && status === "A") return { what: "Unstage and delete this new file", args: [["rm", "-f", "-q", "--"]] };
  if (scope === "staged") return { what: "Discard the staged changes", args: [["restore", "--source=HEAD", "--staged", "--worktree", "--"]] };
  return null;
}

export default class ChangesMenu extends View {
  init(_props, cx) {
    this.ask = null; // "rollback" | "delete" once chosen: the question before it runs
    this.busy = false;
  }

  p() { return props() ?? {}; }
  close() { closeOverlay(props()?.overlay); }

  async run(commands, label, cx) {
    const { root, on } = this.p();
    this.busy = true; cx.notify();
    try {
      for (const [cmd, args] of commands) {
        const r = await exec(cmd, args, { cwd: root, on: on ?? null });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim() || `${cmd} failed`);
      }
      setShared("better-changes.reload", { root, on: on ?? null, at: Date.now() });
    } catch (e) {
      notify({ title: `${label} failed`, body: String(e.message ?? e).slice(0, 200), level: "error", timeout: 6000 });
    }
    this.close();
  }

  render() {
    const t = theme(), { path, scope, status, base } = this.p();
    const name = String(path ?? "").split("/").pop();
    const plan = rollbackPlan(scope, status, base);
    const canStage = scope === "unstaged", canUnstage = scope === "staged", canDelete = Boolean(path);
    const item = (id, icon, label, enabled, action) => h_flex().id(`cm-${id}`).h(30).px(10).gap(10).items_center().rounded(7)
      .text_size(13).text_color(enabled ? t.foreground : t.dim).opacity(enabled ? 1 : 0.5)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => action(cx)))
      .child(svg(ICON(icon)).size(14).flex_none().text_color(enabled ? t.muted : t.dim))
      .child(div().flex_1().child(label));
    if (this.ask) {
      const rb = this.ask === "rollback";
      const text = rb ? `${plan.what}: ${name}?` : `Delete ${name} from the disk?`;
      const go = (cx) => this.run(rb ? plan.args.map((a) => ["git", [...a, path]]) : [["rm", ["-f", "--", path]]], rb ? "Rollback" : "Delete", cx);
      return v_flex().id("cm-ask").w_full().p(10).gap(10).bg(t.popover).text_size(13)
        .child(div().text_color(t.foreground).child(text))
        .child(div().text_size(11.5).text_color(t.dim).child(rb ? "This can't be undone." : "This can't be undone; it isn't moved to the Trash."))
        .child(h_flex().gap(8).justify_end()
          .child(div().id("cm-cancel").h(28).px(12).flex().items_center().rounded(7).cursor_pointer().text_color(t.muted)
            .hover((s) => s.bg(t.hover)).on_click(() => this.close()).child("Cancel"))
          .child(div().id("cm-go").h(28).px(12).flex().items_center().rounded(7).cursor_pointer().bg(t.blocked + "33").text_color(t.blocked)
            .hover((s) => s.bg(t.blocked + "4d")).on_click((_e, cx) => { if (!this.busy) go(cx); }).child(rb ? "Rollback" : "Delete")));
    }
    return v_flex().id("cm").w_full().p(5).gap(1).bg(t.popover)
      .child(item("rollback", "undo", "Rollback…", Boolean(plan), (cx) => { this.ask = "rollback"; cx.notify(); }))
      .child(item("delete", "trash", "Delete…", canDelete, (cx) => { this.ask = "delete"; cx.notify(); }))
      .child(div().h(1).my(4).mx(4).bg(t.border))
      .child(item("stage", "plus", "Stage", canStage, (cx) => this.run([["git", ["add", "--", path]]], "Stage", cx)))
      .child(item("unstage", "minus", "Unstage", canUnstage, (cx) => this.run([["git", ["restore", "--staged", "--", path]]], "Unstage", cx)));
  }
}

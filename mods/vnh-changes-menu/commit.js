// The commit part of the Changes menu (a right-click on a commit of the Commits tab): copy, open on the web, new branch /
// worktree from it, checkout, cherry-pick, revert, reset (soft / mixed / hard) here, undo the last commit.
// A reset saves where HEAD was (and, for hard, the working tree as a stash commit) so its notice can undo it.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, notify, window, home, run } from "herdr";

/** The web address of a commit, from the remote's URL (GitHub, GitLab, Bitbucket), or null. */
export function webCommitUrl(remote, hash) {
  let u = String(remote ?? "").trim().replace(/\.git$/, "");
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(u);
  if (ssh) u = `https://${ssh[1]}/${ssh[2]}`;
  else u = u.replace(/^git:\/\//, "https://").replace(/^https?:\/\/[^@/]+@/, "https://");
  if (!/^https:\/\//.test(u)) return null;
  const host = /^https:\/\/([^/]+)/.exec(u)[1];
  if (/gitlab/.test(host)) return `${u}/-/commit/${hash}`;
  if (/bitbucket/.test(host)) return `${u}/commits/${hash}`;
  return `${u}/commit/${hash}`;
}

/** Items for the menu of a commit. `v` is the menu view; item/line are its row builders. */
export function commitItems(v, t, item, line) {
  const { hash, short, subject, isHead, pushed, hasParent } = v.a();
  const copy = (text, label) => (cx) => { cx.write_to_clipboard(text); notify({ title: `Copied the ${label}`, body: text.slice(0, 80), level: "info", timeout: 2000 }); v.close(); };
  const ask = (what) => (cx) => { v.ask = what; if (what === "branch" || what === "worktree") v.startPrompt(); cx.notify(); };
  const remote = !!v.a().on;
  return [
    item("c-hash", "copy", `Copy hash (${short})`, true, copy(hash, "hash")),
    item("c-msg", "copy", "Copy message", true, async (cx) => {
      const r = await v.git(["log", "-1", "--format=%B", hash]).catch(() => null);
      copy(String(r?.stdout ?? subject).trim(), "message")(cx);
    }),
    item("c-web", "link", "Open on the web", !remote, async () => {
      const r = await v.git(["remote", "get-url", "origin"]).catch(() => null);
      const url = webCommitUrl(r?.stdout, hash);
      if (!url) { notify({ title: "No web address", body: "origin isn't a GitHub, GitLab or Bitbucket remote", level: "warning", timeout: 4000 }); v.close(); return; }
      const os = window()?.platform;
      if (os === "windows") await exec("cmd", ["/c", "start", "", url]).catch(() => null);
      else await exec(os === "linux" ? "xdg-open" : "open", [url]).catch(() => null);
      v.close();
    }),
    line(),
    item("c-branch", "branch", "New branch from here…", true, ask("branch")),
    item("c-worktree", "worktree", "New worktree from here…", !remote, ask("worktree")),
    item("c-checkout", "check", "Checkout (detached)…", true, ask("checkout")),
    line(),
    item("c-pick", "pick", "Cherry-pick onto this branch…", true, ask("cherry")),
    item("c-revert", "undo", "Revert this commit…", true, ask("revert")),
    line(),
    item("c-soft", "reset", "Reset here, keep changes staged…", true, ask("reset-soft")),
    item("c-mixed", "reset", "Reset here, keep changes unstaged…", true, ask("reset-mixed")),
    item("c-hard", "reset", "Reset here, discard changes…", true, ask("reset-hard")),
    item("c-undo", "undo", "Undo this commit (keep its changes)", Boolean(isHead && hasParent), ask("undo-last")),
  ];
}

/** The question (or the name prompt) for the chosen action: { title, note, danger, go(cx) } or null. */
export function commitAsk(v) {
  const { hash, short, subject, pushed } = v.a();
  const label = `${short} ${subject}`.slice(0, 70);
  const warnPushed = pushed ? " It is already on the remote: others may have it." : "";
  const op = (name, fn, ok) => (cx) => v.runOps(name, fn, cx, ok);
  switch (v.ask) {
    case "checkout": return { title: `Checkout ${short}?`, note: "HEAD detaches here; your uncommitted changes come along when they fit.", go: op("Checkout", () => v.git(["switch", "--detach", hash]), `On ${short} (detached)`) };
    case "cherry": return { title: `Cherry-pick ${label}?`, note: "It is applied on top of the current branch; if it conflicts it is aborted and nothing changes.", go: op("Cherry-pick", () => v.tryAbort(["cherry-pick", hash], ["cherry-pick", "--abort"]), "Cherry-picked") };
    case "revert": return { title: `Revert ${label}?`, note: "A new commit undoes it; if it conflicts it is aborted and nothing changes.", go: op("Revert", () => v.tryAbort(["revert", "--no-edit", hash], ["revert", "--abort"]), "Reverted") };
    case "reset-soft": return { title: `Reset to ${short}, keep changes staged?`, note: `The commits after it are undone; their changes stay staged.${warnPushed}`, go: (cx) => v.reset("soft", cx) };
    case "reset-mixed": return { title: `Reset to ${short}, keep changes unstaged?`, note: `The commits after it are undone; their changes stay in the files.${warnPushed}`, go: (cx) => v.reset("mixed", cx) };
    case "reset-hard": return { title: `Reset to ${short}, discard changes?`, note: `The commits after it and every uncommitted change go. They are saved: the notice afterwards undoes it.${warnPushed}`, danger: true, go: (cx) => v.reset("hard", cx) };
    case "undo-last": return { title: `Undo ${label}?`, note: `The commit is removed; its changes stay staged.${warnPushed}`, go: (cx) => v.reset("soft", cx, "HEAD~1", "Undo commit") };
    default: return null;
  }
}

export function startPrompt(v) {
  v.input = InputState.new({ placeholder: v.ask === "worktree" ? "Worktree and branch name" : "Branch name" });
  v.input.on("submit", (_e, cx) => v.submitPrompt(cx));
  v.input.focus();
}

export function promptView(v, t) {
  const wt = v.ask === "worktree";
  return v_flex().id("cm-prompt").w_full().p(10).gap(10).bg(t.popover).text_size(13)
    .child(div().text_color(t.foreground).child(wt ? "New worktree from here" : "New branch from here"))
    .child(h_flex().h(34).px(10).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
      .child(Input.new(v.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
    .child(div().text_size(11.5).text_color(t.dim).child(wt ? "Creates ../<name> on a new branch <name> at this commit, and opens it as a space." : "Creates the branch at this commit and switches to it."))
    .child(h_flex().gap(8).justify_end()
      .child(div().id("cm-cancel").h(28).px(12).flex().items_center().rounded(7).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover)).on_click(() => v.close()).child("Cancel"))
      .child(div().id("cm-create").h(28).px(12).flex().items_center().rounded(7).cursor_pointer().bg(t.accent + "33").text_color(t.foreground)
        .hover((s) => s.bg(t.accent + "4d")).on_click((_e, cx) => v.submitPrompt(cx)).child("Create")));
}

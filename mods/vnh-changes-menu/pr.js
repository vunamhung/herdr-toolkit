// The pull-request part of the Changes menu (⋮ of a PR in the PRs tab, or a right-click on one): open, copy, check out, review in
// its own worktree, hand it to the agent, mark ready, approve, merge, close. Everything goes through `gh`, logged in on this machine
// (or on the machine of the space). Merging names the commit that was seen (--match-head-commit): a newer push is refused.
import { exec, notify, window, run } from "herdr";

const GH = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v gh >/dev/null || { echo "gh is not installed (brew install gh, then gh auth login)" >&2; exit 127; }
exec gh "$@"`;

const AZ = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export AZURE_CORE_NO_COLOR=1 AZURE_CORE_ONLY_SHOW_ERRORS=1 AZURE_CORE_COLLECT_TELEMETRY=0
command -v az >/dev/null || { echo "az is not installed (brew install azure-cli, az extension add --name azure-devops, az login)" >&2; exit 127; }
exec az "$@"`;

// gh on GitHub, az repos on Azure DevOps: the same call for both, the arguments differ.
async function cli(v, bin, script, args) {
  const { root, on } = v.a();
  const r = await exec("sh", ["-c", script, bin, ...args], { cwd: root, on: on ?? null, timeout: 90000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim().split("\n").filter((l) => !/^WARNING/.test(l)).slice(-3).join(" ").slice(0, 300) || `${bin} ${args[0]} failed`);
  return r;
}
const gh = (v, args) => cli(v, "gh", GH, args);
const az = (v, args) => cli(v, "az", AZ, args);

/** The text typed into the agent for "Fix failed checks" / "Review". */
export function agentText(kind, a) {
  const ref = `PR #${a.number} (${a.url})`;
  if (kind === "fix") {
    const names = (a.failed ?? []).map((f) => `- ${f.name}${f.url ? ` ${f.url}` : ""}`).join("\n");
    return `Fix the failing checks of ${ref}, "${a.title}", branch ${a.headRef}.\nFailing:\n${names}\nRead the logs with: the failing check's log (its link is above; on GitHub: gh run view <run id> --log-failed). Find the cause, fix it in this branch, run the check locally, and tell me what you changed. Answer in Vietnamese.`;
  }
  return `Review ${ref}, "${a.title}" (${a.headRef} into ${a.baseRef}). Read it with: git fetch origin ${a.headRef} && git diff origin/${a.baseRef}...FETCH_HEAD, and the discussion on its page. Tell me what is wrong or risky, in order of importance, and what you would change. Do not edit anything or post comments. Answer in Vietnamese.`;
}

/** Items for the menu of a pull request. `v` is the menu view; item/line are its row builders. */
export function prItems(v, t, item, line) {
  const a = v.a(), remote = Boolean(a.on), open = a.state === "OPEN", closed = a.state === "CLOSED", azure = a.forge?.kind === "azure";
  const copy = (text, label) => (cx) => { cx.write_to_clipboard(text); notify({ title: `Copied the ${label}`, body: text.slice(0, 80), level: "info", timeout: 2000 }); v.close(); };
  const ask = (what) => (cx) => { v.ask = what; cx.notify(); };
  const web = async () => {
    const os = window()?.platform;
    if (os === "windows") await exec("cmd", ["/c", "start", "", a.url]).catch(() => null);
    else await exec(os === "linux" ? "xdg-open" : "open", [a.url]).catch(() => null);
    v.close();
  };
  return [
    item("p-web", "link", "Open on GitHub", !remote, () => web()),
    item("p-link", "copy", "Copy link", true, copy(a.url, "link")),
    item("p-num", "copy", `Copy #${a.number}`, true, copy(`#${a.number}`, "number")),
    line(),
    item("p-fix", "at", "Fix the failed checks with the agent", !remote && (a.failed ?? []).length > 0, (cx) => { v.busy = true; v.typeIntoAgent(cx, agentText("fix", a), () => v.close()); }),
    item("p-review", "at", "Review with the agent", !remote && open, (cx) => { v.busy = true; v.typeIntoAgent(cx, agentText("review", a), () => v.close()); }),
    line(),
    item("p-checkout", "branch", `Check out ${a.headRef}…`, open, ask("checkout")),
    item("p-worktree", "worktree", "Review in its own worktree…", !remote && open, ask("worktree")),
    line(),
    item("p-ready", "check", a.isDraft ? "Mark ready for review" : "Convert to draft", open && a.mine, (cx) => v.runOps(a.isDraft ? "Ready" : "Draft",
      () => azure ? az(v, ["repos", "pr", "update", "--id", String(a.number), "--organization", a.forge.orgUrl, "--draft", a.isDraft ? "false" : "true"])
        : gh(v, ["pr", "ready", String(a.number), "-R", a.forge.repo, ...(a.isDraft ? [] : ["--undo"])]), cx, a.isDraft ? "Marked ready for review" : "Converted to draft")),
    item("p-approve", "check", "Approve…", open && !a.mine, ask("approve")),
    item("p-squash", "pick", "Squash and merge…", open && !a.isDraft, ask("merge-squash")),
    item("p-merge", "pick", "Create a merge commit…", open && !a.isDraft, ask("merge-merge")),
    item("p-rebase", "pick", "Rebase and merge…", open && !a.isDraft, ask("merge-rebase")),
    item("p-close", "trash", closed ? "Reopen…" : "Close without merging…", open || closed, ask(closed ? "reopen" : "close")),
  ];
}

/** The question for the chosen action: { title, note, danger, go(cx) } or null. */
export function prAsk(v) {
  const a = v.a(), n = String(a.number), f = a.forge ?? {}, azure = f.kind === "azure", label = `#${n} ${a.title}`.slice(0, 70);
  const op = (name, fn, ok) => (cx) => v.runOps(name, fn, cx, ok);
  const warn = a.verdict && a.verdict !== "Ready to merge" ? ` GitHub says: ${a.verdict.toLowerCase()}.` : "";
  const update = (extra) => az(v, ["repos", "pr", "update", "--id", n, "--organization", f.orgUrl, ...extra]);
  const merge = (flag, name, strategy) => ({
    title: `${name} ${label}?`,
    note: azure ? `The branch ${a.headRef} is deleted afterwards. Azure DevOps refuses it while a policy is not met.`
      : `The branch ${a.headRef} is deleted afterwards.${warn} A newer push is refused.`,
    go: op(name, () => azure
      ? update(["--status", "completed", "--merge-strategy", strategy, "--delete-source-branch", "true"])
      : gh(v, ["pr", "merge", n, "-R", f.repo, flag, "--delete-branch", ...(a.oid ? ["--match-head-commit", a.oid] : [])]), `Merged #${n}`),
  });
  switch (v.ask) {
    case "merge-squash": return merge("--squash", "Squash and merge", "squash");
    case "merge-merge": return merge("--merge", "Merge", "noFastForward");
    case "merge-rebase": return merge("--rebase", "Rebase and merge", "rebase");
    case "approve": return { title: `Approve ${label}?`, note: "Posts an approving vote as you.", go: op("Approve", () => azure ? az(v, ["repos", "pr", "set-vote", "--id", n, "--vote", "approve", "--organization", f.orgUrl]) : gh(v, ["pr", "review", n, "-R", f.repo, "--approve"]), `Approved #${n}`) };
    case "close": return { title: `${azure ? "Abandon" : "Close"} ${label}?`, note: azure ? "The branch stays; you can reactivate it." : "The branch stays; you can reopen it.", danger: true, go: op("Close", () => azure ? update(["--status", "abandoned"]) : gh(v, ["pr", "close", n, "-R", f.repo]), `${azure ? "Abandoned" : "Closed"} #${n}`) };
    case "reopen": return { title: `${azure ? "Reactivate" : "Reopen"} ${label}?`, note: "It goes back to the open list.", go: op("Reopen", () => azure ? update(["--status", "active"]) : gh(v, ["pr", "reopen", n, "-R", f.repo]), `Reopened #${n}`) };
    case "checkout": return {
      title: `Check out ${a.headRef}?`, note: "This folder switches to the pull request's branch; uncommitted changes come along when they fit.",
      go: op("Checkout", () => azure ? v.git(["fetch", "origin", a.headRef]).then(() => v.git(["switch", a.headRef])) : gh(v, ["pr", "checkout", n, "-R", f.repo]), `On ${a.headRef}`),
    };
    case "worktree": return {
      title: `Review #${n} in its own worktree?`,
      note: `Creates ../pr-${n} on a new branch pr-${n} at the pull request's head, and opens it as a space. Your working copy is not touched.`,
      go: op("Worktree", async () => {
        const { root } = v.a();
        const parent = String(root).replace(/\/+$/, "").replace(/\/[^/]*$/, ""), dir = `${parent}/pr-${n}`;
        await v.git(["fetch", "origin", azure ? a.headRef : `pull/${n}/head`]);
        await v.git(["worktree", "add", "-b", `pr-${n}`, dir, "FETCH_HEAD"]);
        run("space.new", { name: `pr-${n}`, folder: dir });
      }, `Worktree pr-${n} created`),
    };
    default: return null;
  }
}

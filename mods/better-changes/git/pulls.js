// VNH: pull requests, read through the GitHub CLI (`gh`, logged in once with `gh auth login`): no token is stored here.
// Nothing in this file touches the view; it runs gh and turns its JSON into what the PRs tab draws.
import { exec } from "herdr";

// gh is not always on the PATH a mod's process gets (Homebrew, ~/.local/bin).
const GH = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v gh >/dev/null || { echo "gh is not installed" >&2; exit 127; }
exec gh "$@"`;

export const LIST_FIELDS =
  "number,title,state,isDraft,author,headRefName,baseRefName,headRefOid,updatedAt,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,reviewRequests,labels,url,additions,deletions,changedFiles";
export const DETAIL_FIELDS =
  "body,files,latestReviews,reviewRequests,statusCheckRollup,mergeable,mergeStateStatus,reviewDecision,headRefOid,state,isDraft,labels,assignees";
// Branches that are where pull requests go, not where they come from.
export const TRUNKS = new Set(["main", "master", "develop", "dev", "trunk", "HEAD"]);

export const gh = (args, root, on) => exec("sh", ["-c", GH, "gh", ...args], { cwd: root, on: on ?? null, timeout: 45000 });

function friendly(r) {
  const msg = String(r.stderr || r.stdout || "").trim();
  if (r.code === 127 || /not installed|not found/i.test(msg)) return "The GitHub CLI isn't installed. Install it (brew install gh), then run gh auth login.";
  if (/auth login|not logged|authentication|GH_TOKEN|HTTP 401/i.test(msg)) return "Not logged in to GitHub. Run gh auth login in a terminal, then refresh.";
  if (/Could not resolve to a Repository|HTTP 404/i.test(msg)) return "GitHub says this repository doesn't exist or you can't see it.";
  return msg.split("\n")[0].slice(0, 200) || "gh failed";
}

export async function ghJson(args, root, on) {
  const r = await gh(args, root, on);
  if (r.code !== 0) throw new Error(friendly(r));
  try { return JSON.parse(r.stdout || "null"); } catch { throw new Error("gh answered something that isn't JSON"); }
}

/** Passed, failed and running checks of a statusCheckRollup, and the failed ones (name, url) to list. */
export function summarize(rollup) {
  const out = { pass: 0, fail: 0, run: 0, total: 0, failed: [], running: [], all: [] };
  for (const c of rollup ?? []) {
    const name = c.name ?? c.context ?? "check";
    const url = c.detailsUrl ?? c.targetUrl ?? "";
    let s;
    if (c.__typename === "StatusContext" || c.state) {
      s = c.state === "SUCCESS" ? "pass" : c.state === "PENDING" || c.state === "EXPECTED" ? "run" : "fail";
    } else if (c.status !== "COMPLETED") s = "run";
    else s = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion) ? "pass" : "fail";
    out.total++;
    out[s]++;
    const row = { name, url, state: s, workflow: c.workflowName ?? "" };
    out.all.push(row);
    if (s === "fail") out.failed.push(row);
    if (s === "run") out.running.push(row);
  }
  return out;
}

/** What stands between the pull request and a merge, as one phrase and a tone (good, bad, warn, dim). */
export function readiness(pr, checks = summarize(pr.statusCheckRollup)) {
  if (pr.state === "MERGED") return { text: "Merged", tone: "merged" };
  if (pr.state === "CLOSED") return { text: "Closed", tone: "bad" };
  if (pr.isDraft) return { text: "Draft", tone: "dim" };
  if (pr.mergeable === "CONFLICTING") return { text: "Conflicts", tone: "bad" };
  if (checks.fail) return { text: "Checks failing", tone: "bad" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { text: "Changes requested", tone: "bad" };
  if (pr.mergeStateStatus === "BEHIND") return { text: "Behind the base", tone: "warn" };
  if (checks.run) return { text: "Checks running", tone: "warn" };
  if (pr.reviewDecision === "REVIEW_REQUIRED") return { text: "Needs review", tone: "warn" };
  if (pr.mergeStateStatus === "BLOCKED") return { text: "Blocked", tone: "warn" };
  return { text: "Ready to merge", tone: "good" };
}

export const reviewLabel = {
  APPROVED: ["Approved", "good"],
  CHANGES_REQUESTED: ["Changes requested", "bad"],
  REVIEW_REQUIRED: ["Needs review", "warn"],
};

export const loginOf = (p) => p?.login ?? p?.name ?? p?.slug ?? "";
export const authorOf = (pr) => String(loginOf(pr.author)).replace(/^app\//, "");
export const atOf = (pr) => Date.parse(pr.updatedAt) / 1000 || 0;

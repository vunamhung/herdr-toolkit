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

// ── Where the pull requests live ───────────────────────────────────────────────
// GitHub through `gh`; Azure DevOps (dev.azure.com, *.visualstudio.com, over https or ssh) through `az repos` (the azure-devops
// extension, `az login` once). Both are turned into one shape, the one gh gives, so the tab and the menu draw them the same way.

/** { kind: "github", repo, web } | { kind: "azure", org, orgUrl, project, repo, web } | null, from the origin URL. */
export function forgeOf(origin, githubRepo) {
  if (githubRepo) return { kind: "github", repo: githubRepo, web: `https://github.com/${githubRepo}` };
  const u = String(origin ?? "").trim().replace(/\.git$/, "");
  let m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/.exec(u);
  let org, orgUrl;
  if (m) { org = m[1]; orgUrl = `https://dev.azure.com/${org}`; }
  else if ((m = /^https?:\/\/([^.@/]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/.exec(u))) {
    org = m[1]; orgUrl = `https://${org}.visualstudio.com`; m = [m[0], org, m[2], m[3]];
  } else if ((m = /^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com[:/]v3\/([^/]+)\/([^/]+)\/([^/?#]+)/.exec(u))) { org = m[1]; orgUrl = `https://dev.azure.com/${org}`; }
  else if ((m = /^[^@/]+@vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/?#]+)/.exec(u))) { org = m[1]; orgUrl = `https://${org}.visualstudio.com`; }
  if (!m) return null;
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const project = dec(m[2]), repo = dec(m[3]);
  return { kind: "azure", org, orgUrl, project, repo, web: `${orgUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}` };
}

const AZ = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export AZURE_CORE_NO_COLOR=1 AZURE_CORE_ONLY_SHOW_ERRORS=1 AZURE_CORE_COLLECT_TELEMETRY=0
command -v az >/dev/null || { echo "az is not installed" >&2; exit 127; }
exec az "$@"`;

export const az = (args, root, on) => exec("sh", ["-c", AZ, "az", ...args], { cwd: root, on: on ?? null, timeout: 60000 });

function azFriendly(r) {
  const msg = String(r.stderr || r.stdout || "").trim();
  if (r.code === 127 || /az is not installed/.test(msg)) return "The Azure CLI isn't installed. Install it (brew install azure-cli), then az extension add --name azure-devops and az login.";
  if (/'repos' is misspelled|not a valid.*command|azure-devops|extension/i.test(msg) && /repos|devops/i.test(msg)) return "Add the Azure DevOps extension: az extension add --name azure-devops, then refresh.";
  if (/az login|az devops login|TF400813|VS30063|not authorized|Please run 'az login'/i.test(msg)) return "Not logged in to Azure DevOps. Run az login (or az devops login with a PAT), then refresh.";
  return msg.split("\n").filter((l) => !/^WARNING/.test(l))[0]?.slice(0, 200) || "az failed";
}

export async function azJson(args, root, on) {
  const r = await az(args, root, on);
  if (r.code !== 0) throw new Error(azFriendly(r));
  try { return JSON.parse(r.stdout || "null"); } catch { throw new Error("az answered something that isn't JSON"); }
}

const branchOf = (ref) => String(ref ?? "").replace(/^refs\/heads\//, "");
const sameBase = (f) => ["--organization", f.orgUrl];
const inRepo = (f) => [...sameBase(f), "--project", f.project, "--repository", f.repo];

// An Azure DevOps pull request in the shape gh gives.
export function fromAzure(p, f) {
  const votes = (p.reviewers ?? []).filter((r) => !r.isContainer);
  const rejected = votes.some((r) => r.vote === -10);
  const required = votes.filter((r) => r.isRequired);
  const approved = (r) => r.vote >= 5;
  return {
    number: p.pullRequestId,
    title: p.title,
    state: p.status === "completed" ? "MERGED" : p.status === "abandoned" ? "CLOSED" : "OPEN",
    isDraft: Boolean(p.isDraft),
    author: { login: p.createdBy?.displayName ?? p.createdBy?.uniqueName ?? "" },
    authorKey: String(p.createdBy?.uniqueName ?? "").toLowerCase(),
    headRefName: branchOf(p.sourceRefName),
    baseRefName: branchOf(p.targetRefName),
    headRefOid: p.lastMergeSourceCommit?.commitId ?? "",
    updatedAt: p.closedDate ?? p.creationDate,
    reviewDecision: rejected ? "CHANGES_REQUESTED" : required.some((r) => !approved(r)) ? "REVIEW_REQUIRED" : votes.some(approved) ? "APPROVED" : "",
    mergeable: p.mergeStatus === "conflicts" ? "CONFLICTING" : "MERGEABLE",
    mergeStateStatus: "",
    statusCheckRollup: [],
    reviewRequests: votes.filter((r) => r.vote === 0).map((r) => ({ login: r.displayName ?? r.uniqueName, key: String(r.uniqueName ?? "").toLowerCase() })),
    latestReviews: votes.filter((r) => r.vote !== 0).map((r) => ({
      author: { login: r.displayName ?? r.uniqueName },
      state: r.vote === -10 ? "CHANGES_REQUESTED" : r.vote === -5 ? "COMMENTED" : "APPROVED",
    })),
    labels: (p.labels ?? []).map((l) => ({ name: l.name })),
    body: p.description ?? "",
    url: `${f.web}/pullrequest/${p.pullRequestId}`,
  };
}

// The policy evaluations (build validation, required reviewers, work items…) as checks.
export function azureChecks(evals, f) {
  const out = [];
  for (const e of evals ?? []) {
    if (e.status === "notApplicable") continue;
    const cfg = e.configuration ?? {};
    const name = cfg.settings?.displayName || cfg.type?.displayName || "policy";
    const build = e.context?.buildId ?? e.context?.lastBuildId;
    const done = e.status === "approved" || e.status === "rejected" || e.status === "broken";
    out.push({
      __typename: "CheckRun", name, workflowName: cfg.isBlocking === false ? "optional" : "",
      status: done ? "COMPLETED" : "IN_PROGRESS", conclusion: e.status === "approved" ? "SUCCESS" : "FAILURE",
      detailsUrl: build ? `${f.orgUrl}/${encodeURIComponent(f.project)}/_build/results?buildId=${build}` : "",
    });
  }
  return out;
}

/** The pull requests (open ones, or of one branch in any state) as gh's shape. */
export async function listPulls(f, root, on, { branch, done } = {}) {
  // The finished ones: merged / completed first, then closed / abandoned, newest first.
  if (done) {
    const at = (p) => Date.parse(p.updatedAt) || 0;
    if (f.kind === "github") {
      const base = ["pr", "list", "-R", f.repo, "--json", LIST_FIELDS];
      const [merged, closed] = await Promise.all([ghJson([...base, "--state", "merged", "--limit", "30"], root, on), ghJson([...base, "--state", "closed", "--limit", "15"], root, on)]);
      return [...merged, ...closed].sort((a, b) => at(b) - at(a));
    }
    const base = ["repos", "pr", "list", ...inRepo(f), "--output", "json"];
    const [completed, abandoned] = await Promise.all([azJson([...base, "--status", "completed", "--top", "30"], root, on), azJson([...base, "--status", "abandoned", "--top", "15"], root, on)]);
    return [...(completed ?? []), ...(abandoned ?? [])].map((p) => fromAzure(p, f)).sort((a, b) => at(b) - at(a));
  }
  if (f.kind === "github") {
    const base = ["pr", "list", "-R", f.repo, "--json", LIST_FIELDS];
    return ghJson(branch ? [...base, "--head", branch, "--state", "all", "--limit", "1"] : [...base, "--state", "open", "--limit", "40"], root, on);
  }
  const args = ["repos", "pr", "list", ...inRepo(f), "--output", "json"];
  const rows = await azJson(branch ? [...args, "--source-branch", branch, "--status", "all", "--top", "1"] : [...args, "--status", "active", "--top", "40"], root, on);
  return (rows ?? []).map((p) => fromAzure(p, f));
}

/** Who "me" is for the Mine / Review filters (a login on GitHub, the account's e-mail on Azure). */
export async function whoami(f, root, on) {
  if (f.kind === "github") { const r = await gh(["api", "user", "--jq", ".login"], root, on); return r.code === 0 ? r.stdout.trim() : null; }
  const r = await az(["account", "show", "--query", "user.name", "-o", "tsv"], root, on);
  return r.code === 0 ? r.stdout.trim().toLowerCase() : null;
}

/** What the detail view adds to a list row: the body, files, reviews, checks. */
export async function pullDetail(f, pr, root, on) {
  if (f.kind === "github") return ghJson(["pr", "view", String(pr.number), "-R", f.repo, "--json", DETAIL_FIELDS], root, on);
  const [p, evals] = await Promise.all([
    azJson(["repos", "pr", "show", "--id", String(pr.number), ...sameBase(f), "--output", "json"], root, on),
    azJson(["repos", "pr", "policy", "list", "--id", String(pr.number), ...sameBase(f), "--output", "json"], root, on).catch(() => []),
  ]);
  const d = fromAzure(p, f);
  d.statusCheckRollup = azureChecks(evals, f);
  d.files = [];
  return d;
}

export const isMine = (pr, me) => Boolean(me) && (pr.authorKey ? pr.authorKey === String(me).toLowerCase() : authorOf(pr) === me);
export const isAskedOf = (pr, me) => Boolean(me) && (pr.reviewRequests ?? []).some((r) => (r.key ? r.key === String(me).toLowerCase() : loginOf(r) === me));
export const createUrl = (f, branch) =>
  f.kind === "github" ? `${f.web}/pull/new/${encodeURIComponent(branch).replace(/%2F/g, "/")}` : `${f.web}/pullrequestcreate?sourceRef=${encodeURIComponent(branch)}`;

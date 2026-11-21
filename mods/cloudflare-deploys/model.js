// Normalized deploy shape shared by every data source:
// { project, kind, id, shortId, status, stage, env, branch, commit, message, url, dashUrl, createdAt, current }
// status: queued | building | deploying | success | failed | canceled | skipped | unknown

export const ACTIVE = new Set(['queued', 'building', 'deploying']);

const firstLine = (s) => (s ? String(s).split('\n')[0].trim() : null);
const shortSha = (s) => (s ? String(s).slice(0, 7) : null);

const workerDashUrl = (accountId, name) =>
  accountId ? `https://dash.cloudflare.com/${accountId}/workers/services/view/${name}/production/deployments` : null;

/** Pages `latest_stage` {name: queued|initialize|clone_repo|build|deploy, status: idle|active|success|failure|canceled|skipped} */
export function pagesStatus(stage) {
  if (!stage) return 'unknown';
  const { name, status } = stage;
  if (status === 'failure') return 'failed';
  if (status === 'canceled') return 'canceled';
  if (status === 'skipped') return 'skipped';
  if (status === 'success') return name === 'deploy' ? 'success' : 'building';
  if (name === 'queued') return 'queued';
  if (name === 'deploy') return 'deploying';
  if (status === 'active' || status === 'idle') return 'building';
  return 'unknown';
}

export function normalizePagesDeployment(d, project, accountId) {
  const meta = d.deployment_trigger?.metadata ?? {};
  return {
    project: project.name,
    kind: 'pages',
    id: d.id,
    shortId: d.short_id ?? String(d.id ?? '').slice(0, 8),
    status: pagesStatus(d.latest_stage),
    stage: d.latest_stage?.name ?? null,
    env: d.environment ?? null,
    branch: meta.branch ?? null,
    commit: shortSha(meta.commit_hash),
    message: firstLine(meta.commit_message),
    url: d.url ?? null,
    dashUrl: accountId && d.id ? `https://dash.cloudflare.com/${accountId}/pages/view/${project.name}/${d.id}` : null,
    createdAt: d.created_on ?? null,
  };
}

/** Workers Builds: status queued|initializing|running|stopped, build_outcome success|fail|skipped|cancelled|terminated */
export function workerBuildStatus(b) {
  switch (b.build_outcome) {
    case 'success': return 'success';
    case 'fail':
    case 'failure': return 'failed';
    case 'cancelled':
    case 'canceled':
    case 'terminated': return 'canceled';
    case 'skipped': return 'skipped';
    default: break;
  }
  if (b.status === 'queued') return 'queued';
  if (b.status === 'initializing' || b.status === 'running') return 'building';
  return 'unknown';
}

export function normalizeWorkerBuild(b, project, accountId) {
  const meta = b.build_trigger_metadata ?? {};
  return {
    project: project.name,
    kind: 'worker',
    id: b.build_uuid,
    shortId: String(b.build_uuid ?? '').slice(0, 8),
    status: workerBuildStatus(b),
    stage: b.status ?? null,
    env: null,
    branch: meta.branch ?? null,
    commit: shortSha(meta.commit_hash),
    message: firstLine(meta.commit_message),
    url: null,
    dashUrl: workerDashUrl(accountId, project.name),
    createdAt: b.created_on ?? null,
  };
}

/**
 * Map wrangler's Pages "Status" text to a status. wrangler prints the time since a successful
 * deploy ("13 minutes ago") and otherwise the stage status title-cased: "Active" and "Idle"
 * mean a build is still in progress, "Failure", "Canceled", "Skipped" are final.
 */
export function statusFromText(text) {
  const t = String(text ?? '').toLowerCase();
  if (/fail/.test(t)) return 'failed';
  if (/cancel/.test(t)) return 'canceled';
  if (/skip/.test(t)) return 'skipped';
  if (/queue/.test(t)) return 'queued';
  if (/deploying/.test(t)) return 'deploying';
  if (/active|idle|build|clone|initiali|in progress/.test(t)) return 'building';
  if (/success|ago|live|complete|just now/.test(t)) return 'success';
  return 'unknown';
}

const UNIT_MS = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };

/** "13 minutes ago" / "an hour ago" / "just now" -> ISO time, or null. Approximate by nature. */
export function timeFromAgo(text, now = Date.now()) {
  const t = String(text ?? '').toLowerCase().trim();
  if (/^(just now|now|a few seconds ago)$/.test(t)) return new Date(now).toISOString();
  const m = t.match(/^(\d+|an?|one)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  return new Date(now - n * UNIT_MS[m[2]]).toISOString();
}

/** `wrangler pages deployment list --json` rows: raw API objects or {Id, Environment, Branch, Source, Deployment, Status, Build}. */
export function normalizeWranglerPagesRow(row, project, accountId) {
  if (row && row.latest_stage) return normalizePagesDeployment(row, project, accountId);
  return {
    project: project.name,
    kind: 'pages',
    id: row.Id ?? row.id ?? null,
    shortId: String(row.Id ?? row.id ?? '').slice(0, 8),
    status: statusFromText(row.Status ?? row.status),
    stage: null,
    env: row.Environment ? String(row.Environment).toLowerCase() : null,
    branch: row.Branch ?? null,
    commit: shortSha(row.Source),
    message: null,
    url: row.Deployment ?? null,
    dashUrl: row.Build ?? null,
    // wrangler shows finish time only for successful deploys ("13 minutes ago").
    createdAt: timeFromAgo(row.Status ?? row.status),
  };
}

/** `wrangler deployments list --json`: successful Worker version deployments (no build status). */
export function normalizeWranglerWorkerDeployment(d, project, accountId) {
  return {
    project: project.name,
    kind: 'worker',
    id: d.id,
    shortId: String(d.id ?? '').slice(0, 8),
    status: 'success',
    stage: null,
    env: null,
    branch: null,
    commit: null,
    message: firstLine(d.annotations?.['workers/message']) ?? (d.source ? `via ${d.source}` : null),
    url: null,
    dashUrl: workerDashUrl(accountId, project.name),
    createdAt: d.created_on ?? null,
  };
}

/** Newest first; flag the newest successful deploy per environment/branch as `current` (live). */
export function markCurrent(deploys) {
  // Only re-sort when every deploy has a timestamp; otherwise keep the source's (newest-first) order.
  // The sort is stable, so equal approximate times ("an hour ago") keep the source order too.
  const sortable = deploys.length && deploys.every((d) => d.createdAt && !Number.isNaN(Date.parse(d.createdAt)));
  const sorted = sortable ? [...deploys].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) : [...deploys];
  const seen = new Set();
  return sorted.map((d) => {
    const key = d.env ?? d.branch ?? '';
    const current = d.status === 'success' && !seen.has(key);
    if (current) seen.add(key);
    return { ...d, current };
  });
}

const RANK = { none: 0, live: 1, error: 2, active: 3, failed: 4 };
export const DISPLAY = { none: '', live: '☁ ✓ live', error: '☁ ? error', active: '☁ ⟳ deploying', failed: '☁ ✗ failed' };

/** Worst state across projects, judged on each project's newest deploy. */
export function summarize(results) {
  let state = 'none';
  for (const r of results) {
    const latest = r.deploys[0];
    let s = 'none';
    if (!latest) s = r.source ? 'none' : 'error';
    else if (latest.status === 'failed') s = 'failed';
    else if (ACTIVE.has(latest.status)) s = 'active';
    else if (latest.status === 'success') s = 'live';
    if (RANK[s] > RANK[state]) state = s;
  }
  return { state, display: DISPLAY[state] };
}

/**
 * Compare newest deploy per project with what we saw last time.
 * First sighting of a project is a silent baseline. mode: failures | all | off
 */
export function diffForNotifications(prevState, results, mode = 'failures') {
  const next = { ...prevState };
  const events = [];
  for (const r of results) {
    const latest = r.deploys[0];
    if (!latest) continue;
    const key = `${r.project.kind}:${r.project.name}`;
    const prev = prevState[key];
    next[key] = { id: latest.id, status: latest.status };
    if (!prev || mode === 'off') continue;
    if (prev.id === latest.id && prev.status === latest.status) continue;
    if (latest.status === 'failed') events.push({ level: 'failure', project: r.project, deploy: latest });
    else if (latest.status === 'success' && mode === 'all') events.push({ level: 'success', project: r.project, deploy: latest });
  }
  return { next, events };
}

/**
 * The build to highlight: a running build if there is one (newest first), else the newest deploy
 * across all projects. Deploys without a timestamp keep their source order (newest first).
 * -> { result, deploy } or null
 */
export function latestDeploy(results) {
  const all = results.flatMap((result) => result.deploys.map((deploy, i) => ({ result, deploy, i })));
  if (!all.length) return null;
  const time = (x) => {
    const v = Date.parse(x.deploy.createdAt ?? '');
    return Number.isNaN(v) ? -Infinity : v;
  };
  const newestFirst = (a, b) => (time(b) - time(a)) || (a.i - b.i);
  const running = all.filter((x) => ACTIVE.has(x.deploy.status));
  const { result, deploy } = (running.length ? running : all).sort(newestFirst)[0];
  return { result, deploy };
}

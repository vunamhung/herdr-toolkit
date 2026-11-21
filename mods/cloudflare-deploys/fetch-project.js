// Source ordering and fallback, shared by the app mod and the TUI plugin.
// `sources` = { api: { fetchDeploys(cfg, project) }, wrangler: { fetchDeploys(cfg, project, { dropToken }) } }
import { markCurrent } from './model.js';

/** Returns { project, source: 'api'|'wrangler'|null, deploys, errors }. */
export async function fetchProject(cfg, project, sources) {
  const order = cfg.source === 'api' ? ['api'] : cfg.source === 'wrangler' ? ['wrangler'] : ['api', 'wrangler'];
  const errors = [];
  let authFailed = false;

  for (const src of order) {
    const accountId = project.accountId || cfg.accountId;
    if (src === 'api' && (!cfg.apiToken || !accountId)) {
      // No token in auto mode is normal (wrangler-only users); only report half-configured setups.
      if (cfg.source === 'api' || cfg.apiToken) errors.push(`api: missing ${cfg.apiToken ? 'CF_ACCOUNT_ID' : 'CF_API_TOKEN'}`);
      continue;
    }
    try {
      const scoped = { ...cfg, accountId };
      const deploys = src === 'api'
        ? await sources.api.fetchDeploys(scoped, project)
        : await sources.wrangler.fetchDeploys(scoped, project, { dropToken: authFailed });
      return { project, source: src, deploys: markCurrent(deploys).slice(0, cfg.limit), errors };
    } catch (e) {
      if (e && (e.status === 401 || e.status === 403)) authFailed = true;
      errors.push(`${src}: ${e?.message ?? e}`);
    }
  }
  return { project, source: null, deploys: [], errors };
}

// VNH: at most 3 at a time. With wrangler each fetch is a node process (~260 MB, ~0.7 s CPU), and
// all at once was 16-32 of them together; the results keep the projects' order.
export async function fetchAll(cfg, projects, sources, limit = 3) {
  const out = new Array(projects.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, projects.length) }, async () => {
    while (next < projects.length) { const i = next++; out[i] = await fetchProject(cfg, projects[i], sources); }
  }));
  return out;
}

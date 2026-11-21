// Cloudflare data sources for the Herdr app: REST API via the app's `fetch`, wrangler via its `exec`.
// Both are passed in, so this file has no app imports and can be tested with stubs.
import { normalizePagesDeployment, normalizeWorkerBuild, normalizeWranglerPagesRow, normalizeWranglerWorkerDeployment } from './model.js';
import { extractJson } from './parse.js';

const BASE = 'https://api.cloudflare.com/client/v4';

// Which wrangler: CF_WRANGLER override -> node_modules/.bin/wrangler in the project or a parent
// -> wrangler on PATH -> npx wrangler@4.
// Where it runs: always a scratch folder under $TMPDIR. wrangler writes a `.wrangler/` cache into its
// working folder, and a `~/.wrangler` folder makes wrangler treat it as its (legacy) config home,
// hiding the user's real `wrangler login`. So never run it from $HOME, nor litter the user's repos.
export const WRANGLER_SH = [
  'w() {',
  '  if [ -n "$CF_WRANGLER" ]; then eval "$CF_WRANGLER \\"\\$@\\""; return; fi',
  '  p="$CF_PROJECT_DIR"',
  '  while [ -n "$p" ] && [ "$p" != "/" ]; do',
  '    if [ -x "$p/node_modules/.bin/wrangler" ]; then "$p/node_modules/.bin/wrangler" "$@"; return; fi',
  '    p=$(dirname "$p")',
  '  done',
  '  if command -v wrangler >/dev/null 2>&1; then wrangler "$@"; return; fi',
  '  npx --yes wrangler@4 "$@"',
  '}',
  'd="${TMPDIR:-/tmp}/cloudflare-deploys-wrangler"',
  'mkdir -p "$d" && cd "$d" && w "$@"',
].join('\n');

const httpError = (message, status) => Object.assign(new Error(message), { status });

export function createSources({ exec, fetch }) {
  const tags = new Map();

  async function cf(cfg, path) {
    let res;
    try {
      res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${cfg.apiToken}`, Accept: 'application/json' } });
    } catch (e) {
      throw httpError(`network: ${e?.message ?? e}`, 0);
    }
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok || !body?.success) {
      const msg = body?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
      throw httpError(msg, res.status);
    }
    return body.result;
  }

  // Workers Builds is keyed by the script's tag, not its name.
  async function workerTag(cfg, name) {
    const key = `${cfg.accountId}/${name}`;
    if (tags.has(key)) return tags.get(key);
    try {
      const scripts = await cf(cfg, `/accounts/${cfg.accountId}/workers/scripts`);
      const tag = scripts?.find((s) => s.id === name)?.tag;
      if (tag) { tags.set(key, tag); return tag; }
    } catch { /* token may lack Workers Scripts: Read; try the name */ }
    return name;
  }

  const api = {
    async fetchDeploys(cfg, project) {
      const acct = encodeURIComponent(cfg.accountId);
      if (project.kind === 'pages') {
        const rows = await cf(cfg, `/accounts/${acct}/pages/projects/${encodeURIComponent(project.name)}/deployments?per_page=${cfg.limit}`);
        return (rows ?? []).map((d) => normalizePagesDeployment(d, project, cfg.accountId));
      }
      const tag = await workerTag(cfg, project.name);
      const rows = await cf(cfg, `/accounts/${acct}/builds/workers/${encodeURIComponent(tag)}/builds?per_page=${cfg.limit}`);
      return (rows ?? []).map((b) => normalizeWorkerBuild(b, project, cfg.accountId));
    },
  };

  /** Run wrangler with `args`, return its parsed JSON output. */
  async function runWrangler(cfg, args, { dropToken = false, cwd, on } = {}) {
    const vars = ['FORCE_COLOR=0', 'NO_COLOR=1', 'WRANGLER_SEND_METRICS=false'];
    if (cfg.accountId) vars.push(`CLOUDFLARE_ACCOUNT_ID=${cfg.accountId}`);
    if (cfg.source === 'wrangler' && cfg.apiToken && !dropToken) vars.push(`CLOUDFLARE_API_TOKEN=${cfg.apiToken}`);
    if (cfg.wrangler) vars.push(`CF_WRANGLER=${cfg.wrangler}`);
    // The API just rejected the token: let wrangler use its own `wrangler login` session instead.
    const unset = dropToken ? ['-u', 'CLOUDFLARE_API_TOKEN'] : [];
    if (cwd) vars.push(`CF_PROJECT_DIR=${cwd}`); // only to find a project-local wrangler; it runs elsewhere
    const r = await exec('env', [...unset, ...vars, 'sh', '-c', WRANGLER_SH, 'sh', ...args], { on: on ?? undefined });
    if (r.code !== 0) {
      const text = `${r.stderr}\n${r.stdout}`;
      if (r.code === 127 || /(wrangler|npx): (command )?not found/.test(text)) {
        throw new Error('wrangler not found (install Node/npx, or set CF_WRANGLER)');
      }
      const line = text.split('\n').map((s) => s.trim()).find((l) => /error|✘|not authenticated|login/i.test(l));
      throw new Error((line || `wrangler exited ${r.code}`).slice(0, 200));
    }
    const parsed = extractJson(r.stdout);
    return Array.isArray(parsed) ? parsed : parsed?.result ?? parsed?.deployments ?? [];
  }

  /** Pages projects, for matching Git-connected projects (no wrangler file) to a repo. */
  api.listPagesProjects = async (cfg) => {
    const rows = await cf(cfg, `/accounts/${encodeURIComponent(cfg.accountId)}/pages/projects`);
    return (rows ?? []).map((p) => {
      const c = p.source?.config ?? {};
      return { name: p.name, git: Boolean(p.source), repo: c.owner && c.repo_name ? `${c.owner}/${c.repo_name}` : null };
    });
  };

  const wrangler = {
    async listPagesProjects(cfg, opts = {}) {
      const rows = await runWrangler(cfg, ['pages', 'project', 'list', '--json'], opts);
      return rows.map((r) => ({
        name: r['Project Name'] ?? r.name,
        git: /^yes$/i.test(String(r['Git Provider'] ?? '')) || Boolean(r.source),
        repo: null, // wrangler doesn't say which repo; matched by name instead
      })).filter((p) => p.name);
    },

    async fetchDeploys(cfg, project, { dropToken = false } = {}) {
      const args = project.kind === 'pages'
        ? ['pages', 'deployment', 'list', '--project-name', project.name, '--json']
        : ['deployments', 'list', '--name', project.name, '--json'];
      const rows = await runWrangler(cfg, args, { dropToken, cwd: project.dir, on: project.machine });
      return project.kind === 'pages'
        ? rows.map((row) => normalizeWranglerPagesRow(row, project, cfg.accountId))
        : rows.map((d) => normalizeWranglerWorkerDeployment(d, project, cfg.accountId));
    },
  };

  return { api, wrangler };
}

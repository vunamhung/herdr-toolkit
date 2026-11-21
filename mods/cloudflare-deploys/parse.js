// Pure parsing helpers shared by the Herdr app mod and the herdr TUI plugin. No I/O here.

/** Minimal .env parser: KEY=value, optional `export`, quotes, # comments. */
export function parseDotenv(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    } else {
      v = v.replace(/\s+#.*$/, '');
    }
    out[m[1]] = v;
  }
  return out;
}

/** Strip // and /* *\/ comments and trailing commas from JSONC, leaving strings intact. */
export function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Read top-level string keys from wrangler.toml (everything before the first [table]). */
export function parseWranglerToml(text) {
  const top = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const m = line.match(/^([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    if (m) top[m[1]] = m[2] ?? m[3];
  }
  return top;
}

export const WRANGLER_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

/** Turn a wrangler config file's text into a project, or null. */
export function projectFromWrangler(text, file) {
  const cfg = file.endsWith('.toml') ? parseWranglerToml(text) : JSON.parse(stripJsonComments(text));
  if (!cfg?.name) return null;
  return {
    kind: cfg.pages_build_output_dir ? 'pages' : 'worker',
    name: String(cfg.name),
    accountId: cfg.account_id || undefined,
    origin: file,
  };
}

/** "pages:site, worker:api" -> [{kind, name}] */
export function parseProjects(spec = '') {
  const projects = [];
  const warnings = [];
  for (const item of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = item.match(/^(pages|workers?):(.+)$/i);
    if (!m) {
      warnings.push(`CF_PROJECTS entry "${item}" needs a pages: or worker: prefix`);
      continue;
    }
    projects.push({ kind: m[1].toLowerCase() === 'pages' ? 'pages' : 'worker', name: m[2].trim(), origin: 'CF_PROJECTS' });
  }
  return { projects, warnings };
}

/** wrangler may print banners/warnings around the JSON; find the JSON block. */
export function extractJson(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[[{]/.test(lines[i])) {
      try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* keep scanning */ }
    }
  }
  throw new Error('could not parse wrangler JSON output');
}

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Build the settings object from a lookup function (env vars, .env file, layout props). */
export function settingsFrom(get) {
  const { projects, warnings } = parseProjects(get('CF_PROJECTS'));
  let source = String(get('CF_SOURCE') || 'auto').toLowerCase();
  if (!['auto', 'api', 'wrangler'].includes(source)) {
    warnings.push(`CF_SOURCE="${source}" is not auto|api|wrangler; using auto`);
    source = 'auto';
  }
  return {
    apiToken: get('CF_API_TOKEN', 'CLOUDFLARE_API_TOKEN'),
    accountId: get('CF_ACCOUNT_ID', 'CLOUDFLARE_ACCOUNT_ID'),
    source,
    wrangler: get('CF_WRANGLER'),
    pollSeconds: num(get('CF_POLL_SECONDS'), 30),
    activePollSeconds: num(get('CF_POLL_ACTIVE_SECONDS'), 10),
    limit: num(get('CF_DEPLOY_LIMIT'), 5),
    notify: String(get('CF_NOTIFY') || 'failures').toLowerCase(),
    projects,
    warnings,
  };
}

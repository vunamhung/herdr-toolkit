// Finds Cloudflare projects for the folders your spaces work in:
//  1. wrangler configs from the folder up to its repo root (also untracked ones),
//  2. wrangler configs tracked anywhere in the repo (monorepos: workers/api/wrangler.toml),
//  3. Git-connected Pages projects (no wrangler file) whose repo matches the folder's git remote.
// I/O is passed in ({ readTextFile, exec, listPagesProjects }) so this can be tested without the app.
import { WRANGLER_FILES, projectFromWrangler } from './parse.js';

const parent = (dir) => {
  const trimmed = dir.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
};

/** Folders from `dir` up to (and including) `root`; just `dir` when root is unknown or unrelated. */
export function ancestors(dir, root) {
  if (!root || !(dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`))) return [dir];
  const out = [];
  let d = dir;
  for (;;) {
    out.push(d);
    if (d === root || d === '/') break;
    d = parent(d);
  }
  return out;
}

/** Candidate folders per space: its start folder plus every terminal's live folder. */
export function spaceFolders(spaces, panes) {
  return spaces.map((s) => {
    const tabIds = new Set((s.tabs ?? []).map((t) => t.id));
    const dirs = [s.folder, ...panes.filter((p) => tabIds.has(p.tab) && p.cwd).map((p) => p.cwd)]
      .filter((d) => typeof d === 'string' && d.startsWith('/'));
    return { space: s, dirs: [...new Set(dirs)] };
  });
}

/** git remote URL -> "owner/repo" (GitHub, GitLab, ssh or https), or null. */
export function parseRemote(url) {
  const m = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Pages projects for a repo: exact owner/repo when known (API), else project name == repo name (wrangler). */
export function matchPages(pages, slug) {
  if (!slug) return [];
  const want = slug.toLowerCase();
  const repoName = want.split('/')[1];
  const exact = pages.filter((p) => p.repo && p.repo.toLowerCase() === want);
  if (exact.length) return exact;
  return pages.filter((p) => !p.repo && p.git && p.name.toLowerCase() === repoName);
}

const TRACKED_GLOBS = WRANGLER_FILES.map((f) => `*${f}`);

export function createDiscovery({ readTextFile, exec, listPagesProjects = null }) {
  const rootCache = new Map(); // `${machine}|${dir}` -> git root or null (stable, kept across scans)

  async function git(args, cwd, on) {
    try {
      const r = await exec('git', ['--no-optional-locks', ...args], { cwd, on: on ?? undefined });
      return r.code === 0 ? r.stdout : null;
    } catch {
      return null; // folder gone or machine offline
    }
  }

  async function gitRoot(dir, on) {
    const key = `${on ?? ''}|${dir}`;
    if (!rootCache.has(key)) rootCache.set(key, (await git(['rev-parse', '--show-toplevel'], dir, on))?.trim() || null);
    return rootCache.get(key);
  }

  /** -> { projects: [...], notes: [...] } */
  async function discover(spaces, panes) {
    const fileCache = new Map(); // path -> project|null, this scan
    const repoCache = new Map(); // root -> { configs: [paths], slug }
    const byKey = new Map();
    const notes = [];
    let pages = null; // fetched once per scan, only if some repo needs it

    const readProject = async (path, on) => {
      const key = `${on ?? ''}|${path}`;
      if (fileCache.has(key)) return fileCache.get(key);
      let found = null;
      try {
        const text = await readTextFile(path, { on: on ?? undefined });
        if (text != null) found = projectFromWrangler(text, path);
      } catch { found = null; }
      if (found) found = { ...found, dir: parent(path), machine: on ?? null };
      fileCache.set(key, found);
      return found;
    };

    const repoInfo = async (root, on) => {
      const key = `${on ?? ''}|${root}`;
      if (!repoCache.has(key)) {
        const listed = await git(['ls-files', '--', ...TRACKED_GLOBS], root, on);
        const configs = (listed ?? '').split('\n').map((s) => s.trim()).filter(Boolean).map((f) => `${root}/${f}`);
        const slug = parseRemote(await git(['remote', 'get-url', 'origin'], root, on));
        repoCache.set(key, { configs, slug });
      }
      return repoCache.get(key);
    };

    const add = (p, space) => {
      const key = `${p.kind}:${p.name}`;
      const existing = byKey.get(key);
      if (!existing) byKey.set(key, { ...p, spaces: [space.name], spaceIds: [space.id] });
      else if (!existing.spaceIds.includes(space.id)) { existing.spaceIds.push(space.id); existing.spaces.push(space.name); }
    };

    for (const { space, dirs } of spaceFolders(spaces, panes)) {
      const on = space.machine;
      for (const dir of dirs) {
        const root = await gitRoot(dir, on);
        // 1. nearest config walking up (catches untracked configs)
        for (const d of ancestors(dir, root)) {
          let hit = null;
          for (const f of WRANGLER_FILES) {
            hit = await readProject(`${d.replace(/\/+$/, '')}/${f}`, on);
            if (hit) break;
          }
          if (hit) { add(hit, space); break; }
        }
        if (!root) continue;
        const { configs, slug } = await repoInfo(root, on);
        // 2. every tracked config in the repo
        for (const path of configs) {
          const p = await readProject(path, on);
          if (p) add(p, space);
        }
        // 3. Git-connected Pages projects for this repo
        if (slug && listPagesProjects) {
          if (pages === null) {
            try { pages = await listPagesProjects(); } catch (e) {
              pages = [];
              notes.push(`couldn't list Pages projects: ${e?.message ?? e}`);
            }
          }
          for (const p of matchPages(pages, slug)) {
            add({ kind: 'pages', name: p.name, dir: root, machine: on ?? null, origin: `git remote ${slug}` }, space);
          }
        }
      }
    }
    return { projects: [...byKey.values()], notes };
  }

  return { discover };
}

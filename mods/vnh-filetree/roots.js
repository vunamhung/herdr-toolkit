// Multi-root space folders and Claude Code `.claude/settings.local.json` + `/add-dir` synchronization.
import { spaces, agents, exec, readTextFile, writeTextFile, notify, shared, setShared, hc } from "herdr";
import { baseOf } from "./git.js";

export const FOLDERS = "vnh.space.folders";            // { [spaceId]: [absolute folder, ...] }
export const CLAUDE_DIRS = "vnh.space.folders.claude"; // { [settings file]: [folders we added there] }
export const MAX_ROOTS = 8;

export const keyOf = (rid, rel) => `\u0001${rid}\u0002${rel}`;
export const headKey = (rid) => `\u0001${rid}\u0003`;
export function parseKey(k) {
  const m = typeof k === "string" ? /^\u0001(\d+)([\u0002\u0003])(.*)$/s.exec(k) : null;
  return m ? { rid: Number(m[1]), head: m[2] === "\u0003", rel: m[3] } : null;
}
export const activeSpace = () => spaces().find((s) => s.active) ?? null;

const quoteArg = (p) => (/\s/.test(p) ? `"${p.replace(/(["\\])/g, "\\$1")}"` : p);
let dirQueue = Promise.resolve();

function claudeDirs(project, add, remove) {
  if (!project || (!add.length && !remove.length)) return Promise.resolve();
  dirQueue = dirQueue.then(async () => {
    const file = `${project}/.claude/settings.local.json`;
    const before = await readTextFile(file).catch(() => null);
    let json = {};
    if (before) {
      try { json = JSON.parse(before); } catch { notify({ title: "Not shared with Claude", body: `${file} is not valid JSON`, level: "warning", timeout: 5000 }); return; }
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        notify({ title: "Not shared with Claude", body: `${file} must be a JSON object`, level: "warning", timeout: 5000 });
        return;
      }
    }
    if (!before && !add.length) return;
    const rawPerms = json.permissions && typeof json.permissions === "object" && !Array.isArray(json.permissions) ? json.permissions : {};
    const mine = new Set((shared(CLAUDE_DIRS) ?? {})[file] ?? []);
    const dirs = new Set(Array.isArray(rawPerms.additionalDirectories) ? rawPerms.additionalDirectories : []);
    for (const p of add) if (!dirs.has(p)) { dirs.add(p); mine.add(p); }
    for (const p of remove) if (mine.has(p)) { dirs.delete(p); mine.delete(p); }
    const permissions = { ...rawPerms, additionalDirectories: [...dirs] };
    if (!dirs.size) delete permissions.additionalDirectories;
    const next = { ...json, permissions };
    if (!Object.keys(permissions).length) delete next.permissions;
    try {
      await exec("mkdir", ["-p", `${project}/.claude`]);
      await writeTextFile(file, JSON.stringify(next, null, 2) + "\n", before);
      setShared(CLAUDE_DIRS, { ...(shared(CLAUDE_DIRS) ?? {}), [file]: [...mine] });
    } catch (e) { notify({ title: "Not shared with Claude", body: String(e?.message ?? e), level: "warning", timeout: 5000 }); }
  }).catch(() => {});
  return dirQueue;
}

// Idle Claude agents of the space get `/add-dir <folder>` sent sequentially so multiple dropped folders don't race.
async function tellAgents(spaceId, folders) {
  for (const a of agents()) {
    if (a.space !== spaceId || a.status !== "idle" || a.app !== "claude-code") continue;
    for (const p of folders) await hc(["send", "--if", "idle", a.address, `/add-dir ${quoteArg(p)}`]).catch(() => {});
  }
}

export async function addSpaceFolders(dirs, primary, project) {
  const sp = activeSpace();
  if (!sp || sp.machine) return [];
  const all = shared(FOLDERS) ?? {}, list = [...(all[sp.id] ?? [])], added = [];
  for (let p of dirs) {
    p = p.replace(/\/+$/, "") || "/";
    if (p === primary || list.includes(p)) continue;
    if (list.length >= MAX_ROOTS - 1) { notify({ title: `A space holds at most ${MAX_ROOTS} folders`, level: "warning", timeout: 4000 }); break; }
    list.push(p); added.push(p);
  }
  if (!added.length) return added;
  setShared(FOLDERS, { ...all, [sp.id]: list });
  await claudeDirs(project, added, []);
  tellAgents(sp.id, added).catch(() => {});
  notify({ title: added.length > 1 ? `Added ${added.length} folders to ${sp.name}` : `Added ${baseOf(added[0])} to ${sp.name}`, body: "Claude agents in this space can use it too.", level: "success", timeout: 3000 });
  return added;
}

export async function removeSpaceFolder(spaceId, path, project) {
  const all = shared(FOLDERS) ?? {}, list = (all[spaceId] ?? []).filter((p) => p !== path);
  const nextAll = { ...all, [spaceId]: list };
  setShared(FOLDERS, nextAll);
  const stillUsedElsewhere = Object.entries(nextAll).some(([id, arr]) => id !== spaceId && Array.isArray(arr) && arr.includes(path));
  if (!stillUsedElsewhere) await claudeDirs(project, [], [path]);
  notify({ title: `Removed ${baseOf(path)} from the space`, body: "Its files are untouched.", level: "info", timeout: 3000 });
}

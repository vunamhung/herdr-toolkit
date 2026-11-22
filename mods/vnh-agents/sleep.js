// Sleeping agents. An idle Claude Code, Codex or Antigravity session holds hundreds of MB; asleep it holds none:
// the agent is asked to exit (its own /exit, so nothing is cut off) and the terminal stays, at its shell, with the
// conversation still on screen. The session is remembered here and listed in the Agents list under "Asleep";
// waking it types the agent's resume command into that same terminal (no new tab), or opens a tab where the
// terminal is gone. After AUTO_MS without a change (and not the terminal in front of you) an idle agent goes to
// sleep by itself.
// The idea (put idle agents to sleep, wake the same conversation) is from fakie-dev/herdr-suspender (MIT); this is a
// much smaller design: no cover panel, no tab of its own, nothing started while everything is awake.
import { hc, exec, run, spaces, terminals, panes, shared, setShared, readTextFile, home, notify } from "herdr";

export const AUTO_MS = 3 * 60 * 1000;
const KEY = "vnh.asleep", AUTO = "vnh.sleep.auto";
const RESUME = { claude: 'claude --resume "$1"', agy: 'agy --conversation "$1"', codex: 'codex resume "$1"' };
const SESSION = /^[0-9A-Za-z][0-9A-Za-z-]{6,80}$/;
const NAME = { claude: "Claude Code", agy: "Antigravity", codex: "Codex" };

export const autoOn = () => shared(AUTO) !== false;
export const setAuto = (on) => setShared(AUTO, Boolean(on));
export const sleepers = () => shared(KEY) ?? [];
const save = (list) => setShared(KEY, list);
export const forget = (id) => save(sleepers().filter((r) => r.id !== id));

/** What the agent in a terminal wrote for the status bar: { provider, session, title, ... }, or null. */
export async function statusOf(terminal) {
  try { return JSON.parse((await readTextFile(`${home()}/.cache/herdr-status/${terminal}.json`)) ?? "null"); } catch { return null; }
}

const agentLeft = (address) => {
  const t = terminals().find((x) => x.address === address);
  return !t || t.state !== "live" || !t.program?.agent;
};
const sleep = (ms) => exec("sleep", [String(ms / 1000)]).catch(() => null);

/** Puts the agent of terminal `a.address` to sleep. -> { ok, why? }. Nothing is killed: the agent is asked to exit and,
 *  if it doesn't within 10 s, left running (the record is dropped again). */
export async function sleepAgent(a, label) {
  const st = await statusOf(a.address);
  if (!st?.provider || !RESUME[st.provider]) return { ok: false, why: "not an agent it can resume" };
  if (!SESSION.test(st.session ?? "")) return { ok: false, why: "no session id yet (the agent hasn't reported one)" };
  const pane = panes().find((p) => p.terminal === a.address);
  const space = spaces().find((s) => s.id === a.space);
  const id = `${st.provider}:${st.session}`;
  const rec = { id, agent: st.provider, session: st.session, terminal: a.address, pane: a.pane ?? pane?.pane ?? null, tab: a.tab ?? null,
    space: a.space ?? null, spaceName: a.space_name ?? space?.name ?? "", cwd: pane?.cwd ?? null, title: label || st.title || a.title || "", at: Date.now() };
  save([rec, ...sleepers().filter((r) => r.id !== id)]);
  await hc(["send", a.address, "/exit"]).catch(() => null);
  for (let i = 0; i < 20; i++) { if (agentLeft(a.address)) return { ok: true }; await sleep(500); }
  forget(id);
  return { ok: false, why: "it didn't exit (it may be asking something)" };
}

/** Wakes a sleeping session: its resume command goes into the terminal it left (still a shell at a prompt), else a new tab of its space. */
export async function wake(rec) {
  const t = terminals().find((x) => x.address === rec.terminal);
  const quoted = `'${rec.session.replace(/'/g, "'\\''")}'`;
  const command = RESUME[rec.agent].replace('"$1"', quoted);
  forget(rec.id);
  if (t && t.state === "live" && !t.program?.agent && t.program?.shell && rec.pane) {
    await hc(["send", rec.terminal, command]).catch(() => null);
    run("pane.focus", { pane: rec.pane });
    return;
  }
  const sp = spaces().find((s) => s.id === rec.space) ?? spaces().find((s) => s.active);
  run("tab.new", { space: sp?.id, folder: rec.cwd ?? undefined, name: (rec.title || NAME[rec.agent]).slice(0, 40), argv: ["sh", "-lc", `exec ${command}`] });
  notify({ title: "Woke in a new tab", body: rec.title || NAME[rec.agent], level: "info", timeout: 3000 });
}

/** Drops sleepers that are running again (resumed by hand): an agent's status file names the same session. */
export async function prune(liveAddresses) {
  const list = sleepers();
  if (!list.length) return;
  const running = new Set();
  for (const address of liveAddresses) { const st = await statusOf(address); if (st?.provider && st.session) running.add(`${st.provider}:${st.session}`); }
  const keep = list.filter((r) => !running.has(r.id));
  if (keep.length !== list.length) save(keep);
}

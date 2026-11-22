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
// How each agent resumes a conversation, with the flags it was started with kept (see launchArgv / flagsOf).
const shq = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;
const RESUME = {
  claude: (bin, id, flags) => [bin, ...flags, "--resume", id],
  agy: (bin, id, flags) => [bin, ...flags, "--conversation", id],
  codex: (bin, id, flags) => [bin, "resume", id, ...flags],
};
// Flags that take a value (the value stays with the flag) and the ones that choose a conversation (dropped: the
// resume brings its own). Anything else that isn't a flag is a prompt or a subcommand and is dropped too.
const VALUE = {
  claude: ["--model", "--permission-mode", "--effort", "--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--append-system-prompt", "--system-prompt", "--mcp-config", "--settings", "--agent", "--agents", "--fallback-model", "--max-turns", "--output-format", "--input-format", "--plugin-dir", "--setting-sources", "--tools", "--betas", "-d", "--name", "-n"],
  agy: ["--agent", "--effort", "--mode", "--model", "--project"],
  codex: ["-m", "--model", "-c", "--config", "-s", "--sandbox", "-a", "--ask-for-approval", "-p", "--profile", "-C", "--cd", "--add-dir", "-i", "--image", "--local-provider"],
};
const DROP_VALUE = { claude: ["--resume", "-r", "--session-id"], agy: ["--conversation"], codex: [] };
const DROP_FLAG = { claude: ["--continue", "-c", "--fork-session"], agy: ["--continue", "-c"], codex: [] };
/** The flags an agent was started with, from its argv, without what picks a conversation or sends a prompt. */
export function flagsOf(agent, argv) {
  const out = [], value = new Set(VALUE[agent]), dv = new Set(DROP_VALUE[agent]), df = new Set(DROP_FLAG[agent]);
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") break;
    const flag = t.split("=")[0];
    if (dv.has(flag)) { if (!t.includes("=") && argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) i++; continue; }
    if (df.has(flag)) continue;
    if (!t.startsWith("-")) continue;
    out.push(t);
    if (!t.includes("=") && value.has(t) && argv[i + 1] !== undefined) out.push(argv[++i]);
  }
  return out;
}
// The agent's own argv, exact (macOS: the kernel's process arguments; Linux: /proc), found under the terminal's shell.
const ARGV = String.raw`import ctypes, ctypes.util, json, os, struct, subprocess, sys

def argv_of(pid):
    if sys.platform == "darwin":
        libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
        mib = (ctypes.c_int * 3)(1, 49, int(pid))  # CTL_KERN, KERN_PROCARGS2
        size = ctypes.c_size_t(0)
        if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0: return None
        buf = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0: return None
        raw = buf.raw[:size.value]
        argc = struct.unpack("i", raw[:4])[0]
        rest = raw[4:]
        i = rest.index(b"\0")                      # the executable path
        while i < len(rest) and rest[i] == 0: i += 1
        parts = rest[i:].split(b"\0")
        return [p.decode("utf-8", "replace") for p in parts[:argc]]
    try:
        return open(f"/proc/{pid}/cmdline", "rb").read().decode("utf-8", "replace").split("\0")[:-1]
    except Exception:
        return None

root = int(sys.argv[1])
table = {}
for line in subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True).stdout.splitlines():
    a = line.split()
    if len(a) == 2: table.setdefault(int(a[1]), []).append(int(a[0]))
names = {"claude", "agy", "codex"}
queue = [root]; seen = set()
while queue:
    p = queue.pop(0)
    if p in seen: continue
    seen.add(p)
    av = argv_of(p)
    if av:
        base = os.path.basename(av[0])
        if base in names: print(json.dumps(av)); sys.exit(0)
        if base in ("node", "bun") and len(av) > 1 and os.path.basename(av[1]) in names:
            print(json.dumps([os.path.basename(av[1])] + av[2:])); sys.exit(0)
    queue += table.get(p, [])
sys.exit(3)
`;
/** [binary, ...arguments] of the agent running under terminal `address`, or null if it can't be read. */
async function launchArgv(address) {
  const got = await hc(["get", address, "--json"]).catch(() => null);
  let pid = null; try { pid = JSON.parse(got?.stdout ?? "null")?.pid ?? null; } catch {}
  if (!pid) return null;
  const r = await exec("python3", ["-c", ARGV, String(pid)], { timeout: 10000 }).catch(() => null);
  try { const av = JSON.parse((r?.stdout ?? "").trim()); return Array.isArray(av) && av.length ? av : null; } catch { return null; }
}
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
  // The flags it was started with come back at wake: if they can't be read, it isn't put to sleep.
  const argv = await launchArgv(a.address);
  if (!argv) return { ok: false, why: "can't read how it was started (its flags would be lost)" };
  const pane = panes().find((p) => p.terminal === a.address);
  const space = spaces().find((s) => s.id === a.space);
  const id = `${st.provider}:${st.session}`;
  const rec = { id, agent: st.provider, session: st.session, bin: argv[0], flags: flagsOf(st.provider, argv), terminal: a.address, pane: a.pane ?? pane?.pane ?? null, tab: a.tab ?? null,
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
  const command = RESUME[rec.agent](rec.bin || rec.agent, rec.session, rec.flags ?? []).map((x, i) => (i === 0 ? x : shq(x))).join(" ");
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

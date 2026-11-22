// Sleeping agents. An idle Claude Code, Codex or Antigravity session holds hundreds of MB; asleep it holds none:
// the agent is asked to exit (its own /exit, so nothing is cut off) and the terminal stays, at its shell, with the
// conversation still on screen. The session is remembered here and listed in the Agents list under "Asleep";
// waking it types the agent's resume command into that same terminal (no new tab), or opens a tab where the
// terminal is gone. After AUTO_MS without a change (and not the terminal in front of you) an idle agent goes to
// sleep by itself.
// The tab keeps its place: where the agent's terminal was, a cover pane (mods/vnh-cover) shows the agent's last screen,
// dimmed, and a click on it wakes the agent. The terminal (a shell at a prompt) is parked out of sight meanwhile and
// comes back into the same slot at wake, with its history.
// The idea (put idle agents to sleep, wake the same conversation) is from fakie-dev/herdr-suspender (MIT); this is a
// much smaller design: no cover panel, no tab of its own, nothing started while everything is awake.
import { hc, exec, run, spaces, terminals, panes, shared, setShared, readTextFile, home, notify, focused } from "herdr";

export const AUTO_MS = 5 * 60 * 1000;
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
// The agent under a terminal's shell: its exact argv (macOS: the kernel's process arguments; Linux: /proc) and the
// conversation it has open (Claude: ~/.claude/sessions/<pid>.json; Codex: its open rollout file; Antigravity: the
// conversation its per-process log talks about most that exists on disk). The status files may not have the id yet.
const ARGV = String.raw`import collections, ctypes, ctypes.util, json, os, re, struct, subprocess, sys

HOME = os.path.expanduser("~")
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

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
        i = rest.index(b"\0")
        while i < len(rest) and rest[i] == 0: i += 1
        return [p.decode("utf-8", "replace") for p in rest[i:].split(b"\0")[:argc]]
    try:
        return open(f"/proc/{pid}/cmdline", "rb").read().decode("utf-8", "replace").split("\0")[:-1]
    except Exception:
        return None

def open_files(pid):
    try:
        out = subprocess.run(["lsof", "-p", str(pid), "-Fn"], capture_output=True, text=True, timeout=8).stdout
    except Exception:
        return []
    return [l[1:] for l in out.splitlines() if l.startswith("n/")]

def session_of(kind, pid):
    """The conversation the process has open, from what the agent itself keeps, or None."""
    try:
        if kind == "claude":
            return json.load(open(f"{HOME}/.claude/sessions/{pid}.json")).get("sessionId")
        files = open_files(pid)
        if kind == "codex":
            for f in files:
                m = re.search(r"rollout-.*?(" + UUID.pattern + r")\.jsonl$", f)
                if m: return m.group(1)
        if kind == "agy":
            conv = f"{HOME}/.gemini/antigravity-cli/conversations"
            for f in files:
                if re.search(r"antigravity-cli/log/cli-.*\.log$", f):
                    count = collections.Counter(UUID.findall(open(f, errors="replace").read()))
                    for cid, _ in count.most_common(5):
                        if os.path.exists(f"{conv}/{cid}.db"): return cid
    except Exception:
        return None
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
        base = os.path.basename(av[0]); kind = None
        if base in names: kind = base
        elif base in ("node", "bun") and len(av) > 1 and os.path.basename(av[1]) in names:
            kind = os.path.basename(av[1]); av = [kind] + av[2:]
        if kind:
            print(json.dumps({"argv": av, "pid": p, "kind": kind, "session": session_of(kind, p)}))
            sys.exit(0)
    queue += table.get(p, [])
sys.exit(3)
`;
/** { argv: [binary, ...arguments], session } of the agent running under terminal `address`, or null if it can't be read. */
async function launchArgv(address) {
  const got = await hc(["get", address, "--json"]).catch(() => null);
  let pid = null; try { pid = JSON.parse(got?.stdout ?? "null")?.pid ?? null; } catch {}
  if (!pid) return null;
  const r = await exec("python3", ["-c", ARGV, String(pid)], { timeout: 10000 }).catch(() => null);
  try { const j = JSON.parse((r?.stdout ?? "").trim()); return Array.isArray(j?.argv) && j.argv.length ? j : null; } catch { return null; }
}
const SESSION = /^[0-9A-Za-z][0-9A-Za-z-]{6,80}$/;
const NAME = { claude: "Claude Code", agy: "Antigravity", codex: "Codex" };

// Agents just woken (module state, this mod's own): a resumed agent reports "done" for a moment before "idle"; the
// list shows it as idle straight away (see isWoken). Cleared at the first status that isn't done, or after 2 min.
export const woke = [];
/** Terminals whose agent was woken and that you haven't looked at since: the list puts them first among the idle ones, with their own status mark. */
export const fresh = new Set();
/** terminal -> when it was last woken (an agent's "idle since" must not predate its wake). */
export const wokeAt = new Map();
export function isWoken(a, changedAt) {
  const now = Date.now();
  for (let i = woke.length - 1; i >= 0; i--) {
    const w = woke[i];
    if (now - w.at > 120000) { woke.splice(i, 1); continue; }
    const mine = w.terminal ? w.terminal === a.address : w.space === a.space && (changedAt ?? 0) >= w.at - 2000;
    if (!mine) continue;
    if (a.status !== "done") { woke.splice(i, 1); return false; }
    return true;
  }
  return false;
}

export const autoOn = () => shared(AUTO) !== false;
export const setAuto = (on) => setShared(AUTO, Boolean(on));
export const sleepers = () => shared(KEY) ?? [];
const save = (list) => setShared(KEY, list);
export const forget = (id) => save(sleepers().filter((r) => r.id !== id));
const patch = (id, fields) => save(sleepers().map((r) => (r.id === id ? { ...r, ...fields } : r)));

/** What the agent in a terminal wrote for the status bar: { provider, session, title, ... }, or null. */
export async function statusOf(terminal) {
  try { return JSON.parse((await readTextFile(`${home()}/.cache/herdr-status/${terminal}.json`)) ?? "null"); } catch { return null; }
}

// Has the agent ended in this terminal (its foreground is the shell again, or the terminal is gone)? Asked of the core
// directly, so it holds for a terminal that is parked behind a cover too.
const SHELLS = /^-?(zsh|bash|fish|sh|dash|nu|elvish|xonsh)$/;
// Has an agent started in this terminal and reported its status (so Herdr shows it as one)?
async function agentUp(address) {
  const got = await hc(["get", address, "--json"]).catch(() => null);
  try {
    const j = JSON.parse(got?.stdout ?? "null");
    return Boolean(j && j.state === "live" && !SHELLS.test(j.foreground?.name ?? "") && j.status);
  } catch { return false; }
}
async function agentLeft(address) {
  const got = await hc(["get", address, "--json"]).catch(() => null);
  try {
    const j = JSON.parse(got?.stdout ?? "null");
    if (!j || j.state !== "live") return true;
    return SHELLS.test(j.foreground?.name ?? "");
  } catch { return false; }
}
const sleep = (ms) => exec("sleep", [String(ms / 1000)]).catch(() => null);
const paneOf = (terminal) => panes().find((p) => p.terminal === terminal)?.pane ?? null;
const paneExists = (pane) => Boolean(pane) && panes().some((p) => p.pane === pane);
async function until(fn, ms = 3000, step = 60) {
  for (let t = 0; t < ms; t += step) { const v = fn(); if (v) return v; await sleep(step); }
  return fn() || null;
}
/** The terminal's screen as text for the cover: no trailing blank lines, long lines cut. */
async function screenOf(address) {
  const r = await hc(["read", address]).catch(() => null);
  const lines = String(r?.stdout ?? "").split("\n").map((l) => l.replace(/\s+$/, "").slice(0, 220));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-100).join("\n");
}
// An unnamed space is called after where its first terminal is: with that terminal parked it would take its folder's
// name, so such a space is pinned to the name it shows, and given back when its last sleeper wakes.
function pinSpace(spaceId) {
  const sp = spaces().find((x) => x.id === spaceId);
  if (!sp || sp.named || !sp.name) return null;
  run("space.rename", { id: sp.id, name: sp.name });
  return sp.name;
}
function unpinSpace(rec) {
  if (!rec.pin) return;
  // Another sleeper still in this space (its terminal is parked too) takes the pin over: the name holds until the last one wakes.
  const others = sleepers().filter((r) => r.id !== rec.id && r.space === rec.space);
  if (others.length > 0) { patch(others[0].id, { pin: rec.pin }); return; }
  const sp = spaces().find((x) => x.id === rec.space);
  if (sp && sp.name === rec.pin) run("space.rename", { id: sp.id, name: "" });
}
/** A space whose terminals are all parked (every agent in it asleep) is called after its folder by Herdr; it must keep the name it
 *  had. Run now and then: renames such a space back to the name its sleeper recorded, and keeps the pin on one sleeper of it. */
export function repairSpaces() {
  const ps = panes();
  for (const sp of spaces()) {
    const tabs = new Set((sp.tabs ?? []).map((t) => t.id));
    const mine = sleepers().filter((r) => r.space === sp.id && r.cover);
    if (!mine.length || ps.some((p) => tabs.has(p.tab) && p.terminal)) continue; // a live terminal names it again, as it should
    const want = mine.find((r) => r.pin)?.pin ?? mine[0].spaceName;
    if (!want) continue;
    if (sp.name !== want) run("space.rename", { id: sp.id, name: want });
    if (!mine.some((r) => r.pin)) patch(mine[0].id, { pin: want });
  }
}

/** Puts the cover where the terminal's pane is and parks the terminal. false: left as it was (the terminal stays at its shell). */
async function coverUp(rec) {
  const P = paneOf(rec.terminal);
  if (!P) return false;
  const before = new Set(panes().map((p) => p.pane));
  run("pane.split", { pane: P, direction: "right", mod: "vnh-cover", props: { id: rec.id } });
  const C = await until(() => panes().find((p) => !before.has(p.pane) && p.mod === "vnh-cover")?.pane ?? null);
  if (!C) return false;
  const pin = pinSpace(rec.space);
  run("pane.swap", { pane: C, target: P });
  run("terminal.park", { terminal: rec.terminal });
  patch(rec.id, { cover: C, tab: panes().find((p) => p.pane === C)?.tab ?? rec.tab, pin });
  return true;
}
/** Takes the cover away: the parked terminal comes back into its slot (Herdr adopts a terminal that carries its tab's labels). -> its pane, or null. */
async function uncover(rec) {
  if (!rec.cover || !paneExists(rec.cover)) return null;
  const tab = panes().find((p) => p.pane === rec.cover)?.tab ?? rec.tab;
  await hc(["label", rec.terminal, `herdr.space=${rec.space}`, `herdr.tab=${tab}`]).catch(() => null);
  const np = await until(() => paneOf(rec.terminal));
  if (!np) return null;
  run("pane.swap", { pane: np, target: rec.cover });
  run("pane.close", { pane: rec.cover });
  return np;
}
/** Drops a sleeper without waking it (the x in the list): the cover goes, the terminal comes back at its shell. */
export async function dismiss(rec) {
  const np = await uncover(rec);
  if (!np && rec.cover && paneExists(rec.cover)) run("pane.close", { pane: rec.cover });
  forget(rec.id);
  unpinSpace(rec);
}

/** Puts the agent of terminal `a.address` to sleep. -> { ok, why? }. Nothing is killed: the agent is asked to exit and,
 *  if it doesn't within 10 s, left running (the record is dropped again). */
export async function sleepAgent(a, label, dry = false) {
  const st = await statusOf(a.address);
  // The flags it was started with come back at wake: if they can't be read, it isn't put to sleep.
  const probe = await launchArgv(a.address);
  if (!probe) return { ok: false, why: "can't read how it was started (its flags would be lost)" };
  const argv = probe.argv, provider = probe.kind ?? st?.provider;
  if (!provider || !RESUME[provider]) return { ok: false, why: "not an agent it can resume" };
  // The conversation the process has open, else what its status line last wrote.
  const session = SESSION.test(probe.session ?? "") ? probe.session : st?.session;
  if (!SESSION.test(session ?? "")) return { ok: false, why: "can't tell which conversation it has open" };
  const pane = panes().find((p) => p.terminal === a.address);
  const space = spaces().find((s) => s.id === a.space);
  const id = `${provider}:${session}`;
  const rec = { id, agent: provider, session, bin: argv[0], flags: flagsOf(provider, argv), terminal: a.address, pane: a.pane ?? pane?.pane ?? null, tab: a.tab ?? null,
    space: a.space ?? null, spaceName: a.space_name ?? space?.name ?? "", cwd: pane?.cwd ?? null, title: label || st?.title || a.title || "", at: Date.now() };
  if (dry) return { ok: true, rec }; // a dry run: what it would do, nothing changed
  rec.screen = await screenOf(a.address);
  save([rec, ...sleepers().filter((r) => r.id !== id)]);
  // The cover goes up at once; the agent exits behind it (the terminal is only hidden, `hc send` still reaches it).
  const covered = await coverUp(rec).catch(() => false);
  await hc(["send", a.address, "/exit"]).catch(() => null);
  for (let i = 0; i < 40; i++) {
    if (await agentLeft(a.address)) return { ok: true };
    await sleep(250);
  }
  // It didn't exit: the cover comes off, the terminal is as it was.
  const fresh = sleepers().find((r) => r.id === id) ?? rec;
  if (covered) await dismiss(fresh); else { forget(id); unpinSpace(fresh); }
  return { ok: false, why: "it didn't exit (it may be asking something)" };
}

/** Wakes a sleeping session: its resume command goes into the terminal it left (still a shell at a prompt), else a new tab of its space. */
export async function wake(rec) {
  const t = terminals().find((x) => x.address === rec.terminal);
  const command = RESUME[rec.agent](rec.bin || rec.agent, rec.session, rec.flags ?? []).map((x, i) => (i === 0 ? x : shq(x))).join(" ");
  // Under a cover: the terminal comes back into the slot first, then it resumes.
  if (rec.cover) {
    // The agent starts first, in the terminal that is still hidden; the cover stays up (it says "Waking…") until the agent
    // has reported itself, and only then does the terminal take the slot: the plain shell is never on screen.
    patch(rec.id, { waking: true });
    wokeAt.set(rec.terminal, Date.now());
    woke.push({ terminal: rec.terminal, space: rec.space, at: Date.now() });
    await hc(["send", rec.terminal, command]).catch(() => null);
    for (let i = 0; i < 100; i++) { if (await agentUp(rec.terminal)) break; await sleep(150); }
    // Waking it doesn't take you to it: only if you were in the cover itself (you clicked it) does the agent get the keyboard.
    const inCover = focused()?.pane === rec.cover;
    const np = await uncover(rec);
    if (np) {
      forget(rec.id); unpinSpace(rec);
      if (inCover) run("pane.focus", { pane: np }); else fresh.add(rec.terminal);
      return;
    }
    // The cover or the terminal is gone: nothing to put back; a terminal still parked is let go, and a tab opens.
    if (t && t.state === "live") run("terminal.kill", { terminal: rec.terminal });
    if (paneExists(rec.cover)) run("pane.close", { pane: rec.cover });
    unpinSpace(rec);
  }
  forget(rec.id);
  wokeAt.set(rec.terminal, Date.now());
  woke.push({ terminal: t && t.state === "live" && !t.program?.agent && t.program?.shell && rec.pane ? rec.terminal : null, space: rec.space, at: Date.now() });
  if (t && t.state === "live" && !t.program?.agent && t.program?.shell && rec.pane) {
    await hc(["send", rec.terminal, command]).catch(() => null);
    return;
  }
  const sp = spaces().find((s) => s.id === rec.space) ?? spaces().find((s) => s.active);
  run("tab.new", { space: sp?.id, focus: false, folder: rec.cwd ?? undefined, name: (rec.title || NAME[rec.agent]).slice(0, 40), argv: ["sh", "-lc", `exec ${command}`] });
  notify({ title: "Woke in a new tab", body: rec.title || NAME[rec.agent], level: "info", timeout: 3000 });
}

/** Drops sleepers that are running again somewhere else (resumed by hand): an agent's status file names the same session
 *  in another terminal. The sleeper's own terminal doesn't count: that is a wake in progress. */
export async function prune(liveAddresses) {
  const list = sleepers();
  if (!list.length) return;
  const running = new Map();
  for (const address of liveAddresses) { const st = await statusOf(address); if (st?.provider && st.session) running.set(`${st.provider}:${st.session}`, address); }
  const keep = list.filter((r) => r.waking || !running.has(r.id) || running.get(r.id) === r.terminal);
  if (keep.length !== list.length) save(keep);
}

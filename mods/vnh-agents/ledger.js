// VNH: the ledger of when each agent was working, for "only this session's files" (better-changes) and anything else that needs to
// know who was active at a given moment. One line per event in ~/.local/state/herdr-ledger/runs.jsonl:
//   {t, ev: "start" | "stop" | "boot", term, sid, cwd, prov}
// A file's modification time says when it was written; this says which agents were working then, in that repository. Written in
// order (one queue), trimmed to the last 3000 lines when it passes 6000. Costs one tiny append per agent turn.
import { exec, home, panes } from "herdr";
import { statusOf } from "./sleep.js";

const DIR = () => `${home()}/.local/state/herdr-ledger`;
const SCRIPT = 'd="$1"; mkdir -p "$d"; printf "%s\\n" "$2" >> "$d/runs.jsonl"; n=$(wc -l < "$d/runs.jsonl"); if [ "$n" -gt 6000 ]; then tmp="$d/runs.tmp.$$"; tail -n 3000 "$d/runs.jsonl" > "$tmp" && mv -f "$tmp" "$d/runs.jsonl" || rm -f "$tmp"; fi; true';
let queue = Promise.resolve();
const enqueue = (fn) => { queue = queue.then(fn).catch(() => null); };
const writeRec = (rec) => exec("sh", ["-c", SCRIPT, "x", DIR(), JSON.stringify(rec)], { timeout: 8000 });

const open = new Map(); // terminal -> { sid } of a run that was started and not stopped
let booted = false;

/** Called with the agents list on every poll: logs the moment an agent starts or stops working (any provider). */
export function trackRuns(list) {
  const now = Date.now();
  if (!booted) { booted = true; enqueue(() => writeRec({ t: now, ev: "boot" })); }
  const live = new Set();
  let paneCwd = null;
  for (const a of list) {
    live.add(a.address);
    const working = a.status === "working";
    if (working && !open.has(a.address)) {
      const rec = { sid: null };
      open.set(a.address, rec);
      paneCwd ??= new Map(panes().map((p) => [p.terminal, p.cwd ?? ""]));
      const cwd = paneCwd.get(a.address) ?? "";
      enqueue(async () => {
        const st = await statusOf(a.address);
        rec.sid = st?.session ?? null;
        await writeRec({ t: now, ev: "start", term: a.address, sid: rec.sid, cwd, prov: st?.provider ?? null });
      });
    } else if (!working && open.has(a.address)) stop(a.address, now);
  }
  for (const address of [...open.keys()]) if (!live.has(address)) stop(address, now); // the terminal is gone
}

function stop(address, t) {
  const rec = open.get(address);
  open.delete(address);
  enqueue(async () => {
    const st = await statusOf(address); // the session id may only have appeared during the turn (a new conversation)
    await writeRec({ t, ev: "stop", term: address, sid: st?.session ?? rec.sid ?? null });
  });
}

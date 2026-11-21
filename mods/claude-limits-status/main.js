import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, panes, theme, window, keys, home, readTextFile, exec, checking, shared, focused } from "herdr";

// What the bar shows for the agent in front of you — Claude Code, Codex or Antigravity (agy) — comes from
// one small file per terminal: ~/.cache/herdr-status/<terminal>.json, written by that agent's own hook
// (status/write.sh and its callers; see README):
//   { provider: "claude" | "codex" | "agy", model, effort, ctx, five, five_reset, seven, seven_reset, updated }
// ctx / five / seven are percent used, *_reset unix seconds. A chat (herdr-chat) runs the agent headless, so
// the patched chat mod publishes the same fields in shared "vnh.chat" under its tab id instead.
const STATUS_DIR = "/.cache/herdr-status";

const PRICE_MS = 120000;
const PRICES = [{ id: "bitcoin", label: "BTC" }, { id: "ethereum", label: "ETH" }, { id: "tether-gold", label: "Gold" }];
const PRICE_URL = `https://api.coingecko.com/api/v3/simple/price?ids=${PRICES.map((c) => c.id).join(",")}&vs_currencies=usd&include_24hr_change=true`;

// Claude's own 5h / 7d, whichever Claude session refreshed last (~/.claude/statusline.sh): what a Claude
// chat falls back on, since a chat never calls the status line script.
const LIMITS_FILE = "/.cache/claude-statusline/limits.json";

// "3h47m" / "2d13h" / "12m" until a unix-seconds reset time.
function untilReset(epoch) {
  if (!epoch) return "";
  const s = Math.max(0, Math.floor(epoch - Date.now() / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 60)}m`;
}

// One shell call for everything the git segment shows (same numbers as the old Claude status line).
const GIT_SCRIPT = `
g() { git --no-optional-locks -c core.fsmonitor=false "$@" 2>/dev/null; }
g rev-parse --is-inside-work-tree >/dev/null || exit 0
echo "@@status"; g status --porcelain=v2 --branch
echo "@@numstat"; g diff HEAD --numstat
echo "@@stash"; g stash list | wc -l
gd=$(g rev-parse --absolute-git-dir)
echo "@@state"
{ [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ]; } && echo REBASING
[ -f "$gd/MERGE_HEAD" ] && echo MERGING
true`;

function parseGit(out) {
  const sections = {};
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) { cur = line.slice(2); sections[cur] = []; continue; }
    if (cur && line) sections[cur].push(line);
  }
  if (!sections.status) return null;
  const info = { staged: 0, modified: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0, added: 0, removed: 0, stash: 0, state: [] };
  for (const l of sections.status) {
    if (l.startsWith("# branch.head ")) info.head = l.slice(14).trim();
    else if (l.startsWith("# branch.ab ")) {
      const m = l.match(/\+(\d+) -(\d+)/);
      if (m) { info.ahead = +m[1]; info.behind = +m[2]; }
    } else if (l.startsWith("? ")) info.untracked++;
    else if (l.startsWith("u ")) info.conflicts++;
    else if (l.startsWith("1 ") || l.startsWith("2 ")) {
      const xy = l.slice(2, 4);
      if (xy[0] !== ".") info.staged++;
      if (xy[1] !== ".") info.modified++;
    }
  }
  for (const l of sections.numstat ?? []) {
    const [a, d] = l.split("\t");
    info.added += +a || 0; info.removed += +d || 0; // binary files show "-"
  }
  info.stash = +(sections.stash?.[0] ?? "0").trim() || 0;
  info.state = sections.state ?? [];
  return info;
}

// Overall CI from gh's statusCheckRollup: "fail" > "pending" > "pass"; null with no checks.
function ciState(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return null;
  let pending = false;
  for (const c of checks) {
    if (c.__typename === "StatusContext" || c.state) {
      const st = String(c.state ?? "").toUpperCase();
      if (st === "FAILURE" || st === "ERROR") return "fail";
      if (st === "PENDING" || st === "EXPECTED" || !st) pending = true;
    } else {
      if (String(c.status ?? "").toUpperCase() !== "COMPLETED") { pending = true; continue; }
      const co = String(c.conclusion ?? "").toUpperCase();
      if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(co)) return "fail";
    }
  }
  return pending ? "pending" : "pass";
}

// CI wall-clock time over CheckRuns: earliest start to latest finish (finish null while any runs).
// Unset GitHub times come as 0001-01-01; StatusContexts carry no times and are skipped.
function ciTiming(checks) {
  const t = (v) => { const ms = v ? Date.parse(v) : NaN; return ms > Date.UTC(2000, 0, 1) ? ms : null; };
  let start = null, end = null, running = false;
  for (const c of Array.isArray(checks) ? checks : []) {
    if (c.__typename === "StatusContext" || c.state) continue;
    const s = t(c.startedAt), e = t(c.completedAt);
    if (s != null) start = start == null ? s : Math.min(start, s);
    if (String(c.status ?? "").toUpperCase() !== "COMPLETED") running = true;
    else if (e != null) end = end == null ? e : Math.max(end, e);
  }
  if (start == null) return null;
  return { start, end: running ? null : end };
}

// "45s" / "4m12s" / "1h05m".
function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

// The folder the focused work happens in. A mod pane (the Markdown viewer, …) has none, and a
// space's starting folder can be another project: fall back to the last terminal folder focused
// in this space (shared "vnh.lastCwd", kept by vnh-files), then the space's first terminal, then
// its starting folder.
function workFolder(space, f) {
  if (!space) return null;
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane?.terminal && pane.cwd) return pane.cwd;
  if (f && f.pane === null && f.terminal && f.cwd) return f.cwd; // a layout terminal block
  const last = (shared("vnh.lastCwd") ?? {})[space.id];
  if (last) return last;
  const tabs = new Set(space.tabs.map((t) => t.id)), active = space.tabs.find((t) => t.active)?.id;
  const terms = panes().filter((p) => p.terminal && p.cwd && tabs.has(p.tab));
  return (terms.find((p) => p.tab === active) ?? terms[0])?.cwd ?? space.folder ?? null;
}

// Clone of Herdr's workspace-status with Claude Code's model and usage limits next to the agents count.
export default class ClaudeLimitsStatus extends View {
  init(_props, cx) {
    this.raw = null; // { file, term, claude }: the focused terminal's status file and Claude's 5h / 7d
    this.lastShown = null; // the last agent shown, kept while a shell or a mod pane has the focus
    this.git = null; // { key, info }
    this.gitAt = 0;
    this.gitBusy = false;
    this.pr = null; // { key, pr }  key: machine:cwd:branch
    this.prAt = 0;
    this.prBusy = false;
    if (checking()) return;
    this.refresh(cx);
    // Gentle poll: the file changes at most every few seconds, and timers keep running while hidden.
    cx.timer.every(5000, (cx) => this.refresh(cx));
    // Git: re-read at once when the shown folder changes, else every 6 s.
    this.refreshGit(cx);
    cx.timer.every(1500, (cx) => { this.followFocus(cx); this.refreshGit(cx); });
    // Prices: at once, then every 2 min while the window is active (none while it's in the background).
    this.refreshPrices(cx);
    cx.timer.every(PRICE_MS, (cx) => this.refreshPrices(cx));
  }

  // BTC, ETH and gold (Tether Gold, one token per troy ounce) from CoinGecko's public price API:
  // one GET, no key, nothing about the person. A failure keeps the last prices.
  refreshPrices(cx) {
    // The first fetch runs even in the background, so the bar isn't empty until the window is used.
    if (this.pricesBusy || (this.prices && !window()?.active) || Date.now() - (this.pricesAt ?? 0) < PRICE_MS - 1000) return;
    this.pricesBusy = true;
    cx.spawn(async (cx) => {
      try {
        // CoinGecko answers 403 without a User-Agent: a generic one, nothing about the person.
        const r = await fetch(PRICE_URL, { headers: { Accept: "application/json", "User-Agent": "herdr-status-bar" } });
        if (!r.ok) this.pricesError = `HTTP ${r.status}`;
        if (r.ok) {
          const j = await r.json();
          const pick = (id) => (typeof j?.[id]?.usd === "number" ? { usd: j[id].usd, change: j[id].usd_24h_change ?? null } : null);
          const next = PRICES.map((c) => ({ ...c, quote: pick(c.id) })).filter((c) => c.quote);
          if (next.length) { this.prices = next; this.pricesAt = Date.now(); cx.notify(); }
        }
      } catch (e) { this.pricesError = String(e?.message ?? e); } finally { this.pricesBusy = false; }
    });
  }

  // "BTC $63,176 +0.1%": the price in the bar's color, the 24 h change green or red.
  priceRow(t) {
    if (!this.prices?.length) return null;
    // toLocaleString has no grouping in the mod runtime: group by hand; whole dollars from $100 up.
    const money = (n) => {
      const [whole, cents] = (n >= 100 ? Math.round(n).toString() : n.toFixed(2)).split(".");
      return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${cents ? `.${cents}` : ""}`;
    };
    return h_flex().id("prices").gap(12).items_center().cursor_pointer()
      .tooltip("24 h change · CoinGecko (gold: Tether Gold) · click to refresh")
      .on_click((_e, cx) => { this.pricesAt = 0; this.refreshPrices(cx); })
      .children(this.prices.map((c) => {
        const ch = c.quote.change;
        return h_flex().gap(5).items_center()
          .child(div().text_color(t.dim).child(c.label))
          .child(div().child(money(c.quote.usd)))
          .when(typeof ch === "number", (el) => el.child(div().text_color(ch >= 0 ? t.ansi2 : t.ansi1).child(`${ch >= 0 ? "+" : "−"}${Math.abs(ch).toFixed(1)}%`)));
      }));
  }

  // The folder the bar describes: the active space's focused terminal, else its folder.
  gitTarget() {
    const space = spaces().find((s) => s.active);
    if (!space) return null;
    const cwd = workFolder(space, focused());
    return cwd ? { cwd, on: space.machine ?? null, key: `${space.machine ?? ""}:${cwd}` } : null;
  }

  refreshGit(cx) {
    // While the Herdr window is in the background, run no git/gh at all; the first tick after it
    // becomes active again sees a stale timestamp and refreshes at once.
    if (!window()?.active && this.git) return;
    if (this.pr?.pr?.ci === "pending" && Date.now() - (this.tickAt ?? 0) >= 10000) { this.tickAt = Date.now(); cx.notify(); }
    const target = this.gitTarget();
    const moved = (target?.key ?? null) !== (this.git?.key ?? null);
    if (this.gitBusy || (!moved && Date.now() - this.gitAt < 6000)) return;
    if (!target) { if (this.git) { this.git = null; cx.notify(); } return; }
    this.gitBusy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", GIT_SCRIPT], { cwd: target.cwd, on: target.on, timeout: 15000 }).catch(() => null);
        const info = r && r.code === 0 ? parseGit(r.stdout) : null;
        const next = { key: target.key, info };
        if (JSON.stringify(next) !== JSON.stringify(this.git)) { this.git = next; cx.notify(); }
        this.refreshPr(cx, target, info?.head);
      } finally {
        this.gitAt = Date.now();
        this.gitBusy = false;
      }
    });
  }

  // The branch's pull request via `gh`, at most once a minute per branch (it goes to the network).
  refreshPr(cx, target, head) {
    const key = head && head !== "(detached)" ? `${target.key}:${head}` : null;
    if (!key) { if (this.pr) { this.pr = null; cx.notify(); } return; }
    const moved = key !== this.pr?.key;
    if (this.prBusy || (!moved && Date.now() - this.prAt < 60000)) return;
    if (moved && this.pr) { this.pr = null; cx.notify(); } // don't show another branch's PR meanwhile
    this.prBusy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("gh", ["pr", "view", "--json", "number,url,state,isDraft,reviewDecision,statusCheckRollup"],
          { cwd: target.cwd, on: target.on, timeout: 20000 }).catch(() => null);
        let pr = null;
        if (r && r.code === 0) {
          try {
            const j = JSON.parse(r.stdout);
            pr = { number: j.number, url: j.url, state: j.state, draft: j.isDraft, review: j.reviewDecision,
              ci: ciState(j.statusCheckRollup), ciTime: ciTiming(j.statusCheckRollup) };
          } catch { pr = null; }
        }
        const next = { key, pr };
        if (JSON.stringify(next) !== JSON.stringify(this.pr)) { this.pr = next; cx.notify(); }
      } finally {
        this.prAt = Date.now();
        this.prBusy = false;
      }
    });
  }

  // "#123 ✓ approved": click opens the PR.
  prStatus(t) {
    const pr = this.pr?.pr;
    if (!pr || !pr.number) return null;
    const row = h_flex().id("pr").gap(6).items_center().cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => { if (pr.url) exec("open", [pr.url]).catch(() => {}); })
      .child(div().child(`#${pr.number}`));
    if (pr.ci === "pass") row.child(div().text_color(t.ansi2).child("✓"));
    else if (pr.ci === "fail") row.child(div().text_color(t.blocked).child("✗"));
    else if (pr.ci === "pending") row.child(div().text_color(t.ansi3).child("●"));
    // How long CI took, or has been running so far (kept fresh by the git timer).
    if (pr.ci && pr.ciTime) row.child(div().child(fmtDuration((pr.ciTime.end ?? Date.now()) - pr.ciTime.start)));
    if (pr.draft) row.child(div().child("draft"));
    else if (pr.state === "MERGED") row.child(div().child("merged"));
    else if (pr.state === "CLOSED") row.child(div().child("closed"));
    if (pr.review === "APPROVED") row.child(div().text_color(t.ansi2).child("approved"));
    else if (pr.review === "CHANGES_REQUESTED") row.child(div().text_color(t.blocked).child("changes requested"));
    return row;
  }

  // "⚔1 ●2 ✚3 ?1 ↑2 ↓1 +40/−7 stash 1 REBASING": zero counts are left out.
  gitStats(t) {
    const g = this.git?.info;
    if (!g) return null;
    const parts = [];
    const add = (text, color) => parts.push(color ? div().text_color(color).child(text) : div().child(text));
    if (g.conflicts) add(`⚔${g.conflicts}`, t.blocked);
    if (g.staged) add(`●${g.staged}`, t.ansi2);
    if (g.modified) add(`✚${g.modified}`, t.ansi3);
    if (g.untracked) add(`?${g.untracked}`, t.dim);
    if (g.ahead) add(`↑${g.ahead}`);
    if (g.behind) add(`↓${g.behind}`, t.blocked);
    if (g.added || g.removed) {
      parts.push(h_flex().items_center()
        .child(div().text_color(t.ansi2).child(`+${g.added}`))
        .child(div().child("/"))
        .child(div().text_color(t.blocked).child(`−${g.removed}`)));
    }
    if (g.stash) add(`stash ${g.stash}`);
    for (const s of g.state) add(s, t.blocked);
    return parts.length ? h_flex().gap(6).items_center().children(parts) : null;
  }

  // The terminal under the keyboard changed: re-read at once. A mod pane (the Files panel, a chat…) has no
  // terminal, so the last one stays.
  followFocus(cx) {
    const t = focused()?.terminal ?? null;
    if (t && t !== this.focusTerm) { this.focusTerm = t; this.refresh(cx); }
  }

  // Which agent a terminal runs, by what Herdr knows of it: "claude" | "codex" | "agy", or null for a shell,
  // an agent this bar doesn't know, or no agent at all.
  providerOf(terminal) {
    const a = terminal ? agents().find((x) => x.address === terminal) : null;
    if (!a) return null;
    const id = `${a.app ?? ""} ${a.program?.key ?? ""} ${a.program?.name ?? ""}`.toLowerCase();
    return /claude/.test(id) ? "claude" : /codex/.test(id) ? "codex" : /agy|antigravity/.test(id) ? "agy" : "other";
  }

  // The file of the focused terminal, plus Claude's own limits for a Claude chat. Nothing here guesses: a
  // terminal whose agent hasn't written its file yet, or whose file is from another agent that ran in the
  // same terminal before, shows no model ("…") rather than somebody else's.
  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const read = async (path) => { const text = await readTextFile(path); return text ? JSON.parse(text) : null; };
        const term = this.focusTerm && /^[\w-]+$/.test(this.focusTerm) ? this.focusTerm : null;
        const file = term ? await read(`${home()}${STATUS_DIR}/${term}.json`).catch(() => null) : null;
        const claude = await read(home() + LIMITS_FILE).catch(() => null);
        const next = { file, term, claude };
        if (JSON.stringify(next) !== JSON.stringify(this.raw)) {
          this.raw = next;
          cx.notify();
        }
      } catch {
        // half-written or invalid file: keep the last good values
      }
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  // "14%/5h 3h47m": only the percentage is colored (green / yellow >=60 / red >=85); the rest
  // inherits the bar's text color and size like the other segments.
  limit(t, pct, windowLabel, reset) {
    const color = pct >= 85 ? t.blocked : pct >= 60 ? t.ansi3 : t.ansi2;
    return h_flex().gap(4).items_center()
      .child(div().text_color(color).child(`${pct}%`))
      .child(div().child(`/${windowLabel}`))
      .when(Boolean(reset), (el) => el.child(div().child(untilReset(reset))));
  }

  // The chat in front of you, if the shown tab is a chat: the patched chat mod publishes its provider,
  // model, effort and context under its tab id in shared "vnh.chat" while that tab is shown
  // (patches/chat-vnh.patch), since a chat runs the agent headless and no hook or status line runs.
  liveChat() {
    const tab = focused()?.tab;
    return (tab ? (shared("vnh.chat") ?? {})[tab] : null) ?? null;
  }

  // What to show now: { model, effort, ctx, five, five_reset, seven, seven_reset } or null for nothing.
  //  - a chat in front: its own model / effort / context; Claude chats take Claude's 5h / 7d from the last
  //    Claude session, other chats show none;
  //  - a terminal running an agent: the file that agent wrote for it, if it is the same agent;
  //  - a shell or a pane that isn't a terminal: the last agent shown, so the bar doesn't blink away.
  current() {
    const raw = this.raw ?? {};
    const chat = this.liveChat();
    if (chat) {
      const limits = /claude|anthropic/i.test(chat.provider ?? "") ? raw.claude ?? {} : {};
      return { model: chat.model, effort: chat.effort, ctx: chat.ctx, five: limits.five, five_reset: limits.five_reset, seven: limits.seven, seven_reset: limits.seven_reset };
    }
    const running = this.providerOf(raw.term);
    if (running) {
      const f = raw.file;
      const same = f && (running === "other" || f.provider === running);
      const shown = same ? f : { model: null };
      this.lastShown = shown;
      return shown;
    }
    return this.lastShown ?? null;
  }

  // "Opus 4.8 high": the model as its agent names it, the effort after it, dimmer. A name that already
  // carries it ("Gemini 3.8 Flash (High)") isn't repeated.
  modelLabel(t, l) {
    const effort = l.effort && !String(l.model ?? "").toLowerCase().includes(String(l.effort).toLowerCase()) ? l.effort : null;
    return h_flex().gap(5).items_center()
      .child(div().child(l.model ?? "…"))
      .when(Boolean(effort), (el) => el.child(div().text_color(t.dim).child(effort)));
  }

  agentSegment(t) {
    const l = this.current();
    if (!l) return null;
    const row = h_flex().gap(10).items_center()
      .child(div().child("|"))
      .child(this.modelLabel(t, l));
    if (typeof l.five === "number") row.child(this.limit(t, Math.round(l.five), "5h", l.five_reset));
    if (typeof l.seven === "number") row.child(this.limit(t, Math.round(l.seven), "7d", l.seven_reset));
    if (typeof l.ctx === "number") row.child(this.limit(t, Math.round(l.ctx), "ctx", null));
    return row;
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const claude = this.agentSegment(t);
    const gitStats = this.gitStats(t);
    const head = this.git?.info?.head;
    const branch = space?.branch ?? (head && head !== "(detached)" ? head : null);
    const prStatus = this.prStatus(t);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      // A mod pane (Markdown viewer…) gives the space no branch; use the one git reported for the work folder.
      .when(Boolean(branch), el => el.child(h_flex().gap(8).items_center().child(label("branch", branch))
        .when(Boolean(gitStats), el => el.child(gitStats))
        .when(Boolean(prStatus), el => el.child(prStatus))))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .when(Boolean(claude), el => el.child(claude))
      .child(div().flex_1())
      // VNH: crypto and gold prices where the palette hint was (⌘⇧P still opens the palette).
      .when(Boolean(this.priceRow(t)), (el) => el.child(this.priceRow(t)));
  }
}

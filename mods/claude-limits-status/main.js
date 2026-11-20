import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Popover, HoverCard } from "gpui-base";
import { spaces, agents, panes, theme, run, window, keys, home, readTextFile, writeTextFile, exec, checking, shared, focused, notify } from "herdr";

// The model picker's two tiers come from Claude Code's own model catalog, which it refreshes itself —
// so the menu never invents a model or an effort level. ~/.claude/cache/model-catalog/<account>.json:
//   catalog.config.models[]  { id, name ("Opus 5.5"), section ("main" = the quick picker), quick_select,
//                              thinking: { effort_options: [{ id, name, badge? }] } }  the real effort
//                              levels that model supports, named as Claude shows them ("Extra" = xhigh).
//   catalog.state.thinking_by_model[]  { id, thinking: { effort } }  each model's persisted effort.
// Picking is silent: nothing is typed into any Claude Code terminal. Tier 1 sets the default model
// for NEW sessions in ~/.claude/settings.json (`model`; "Default" removes it); tier 2 also saves that
// model's effort (`modelSettings.<id>.effortLevel`). A running session keeps its own model (it holds
// it in memory and ignores the file), so the result is a corner toast, not a change in the terminal.
// Claude Code only persists these efforts as defaults; "max" is session-only, so it isn't saved.
const CATALOG_DIR = "/.claude/cache/model-catalog";
const SETTINGS_FILE = "/.claude/settings.json";
const PERSISTED_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

const PRICE_MS = 120000;
const PRICES = [{ id: "bitcoin", label: "BTC" }, { id: "ethereum", label: "ETH" }, { id: "tether-gold", label: "Gold" }];
const PRICE_URL = `https://api.coingecko.com/api/v3/simple/price?ids=${PRICES.map((c) => c.id).join(",")}&vs_currencies=usd&include_24hr_change=true`;

// Written by ~/.claude/statusline.sh on every Claude Code status refresh:
// { model, effort, five, five_reset, seven, seven_reset, ctx, updated } (resets/updated: unix seconds;
// ctx: context window used %, of the session that refreshed last).
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
    this.limits = null;
    this.menuOpen = false; // the model picker's dropup
    this.catalog = null; // Claude Code's model catalog (models + per-model effort), loaded below
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
    // Model catalog: once now, then every 30 s (Claude Code rewrites it rarely).
    cx.spawn(async (cx) => { await this.loadCatalog(); cx.notify(); });
    cx.timer.every(30000, (cx) => cx.spawn(async (cx) => { await this.loadCatalog(); cx.notify(); }));
  }

  // Read Claude Code's own model catalog (newest file in the per-account folder). Keeps the last good
  // one on any failure so the menu never empties.
  async loadCatalog() {
    try {
      const dir = home() + CATALOG_DIR;
      const r = await exec("sh", ["-c", 'ls -t "$1"/*.json 2>/dev/null | head -1', "_", dir]).catch(() => null);
      const file = (r?.stdout ?? "").trim();
      if (!file) return;
      const cat = JSON.parse(await readTextFile(file))?.catalog;
      if (!cat?.config?.models) return;
      const next = {
        models: cat.config.models,
        effortByModel: Object.fromEntries((cat.state?.thinking_by_model ?? []).map((m) => [m.id, m.thinking?.effort ?? null])),
      };
      if (JSON.stringify(next) !== JSON.stringify(this.catalog)) this.catalog = next;
    } catch {
      // half-written or missing: keep the last good catalog
    }
    await this.loadDefaults();
  }

  // What new sessions will use: `model` and each model's `effortLevel` from ~/.claude/settings.json.
  async loadDefaults() {
    try {
      const j = JSON.parse((await readTextFile(home() + SETTINGS_FILE)) || "{}");
      const effort = {};
      for (const [id, s] of Object.entries(j.modelSettings ?? {})) if (s?.effortLevel) effort[id] = s.effortLevel;
      this.defaults = { model: typeof j.model === "string" ? j.model : null, effort };
    } catch {
      // unreadable for a moment: keep the last values
    }
  }

  // The catalog model new sessions start on: `model` is an id or an alias ("opus", "fable") that means
  // the newest model of that family, which the catalog lists first. null = the account default.
  defaultModel() {
    const want = (this.defaults?.model || "").toLowerCase();
    if (!want) return null;
    const models = this.catalog?.models ?? [];
    return models.find((m) => m.id === want) ?? models.find((m) => (m.short_name || "").toLowerCase() === want) ?? null;
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

  // The terminal under the keyboard changed: re-read at once. A mod pane (the Files panel…) has no
  // terminal, so the last one stays.
  followFocus(cx) {
    const t = focused()?.terminal ?? null;
    if (t && t !== this.focusTerm) { this.focusTerm = t; this.refresh(cx); }
  }

  // The bar shows the Claude session you're looking at: model, effort and context from that terminal's
  // limits-<terminal>.json, and the account-wide 5h / 7d from limits.json (the last session to refresh).
  // A shell or another non-Claude terminal keeps showing the last Claude one; a Claude session that
  // hasn't written its file yet shows no model rather than another session's.
  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const read = async (name) => { const text = await readTextFile(`${home()}/.cache/claude-statusline/${name}`); return text ? JSON.parse(text) : null; };
        const shared = await read("limits.json");
        const term = this.focusTerm && /^[\w-]+$/.test(this.focusTerm) ? this.focusTerm : null;
        const mine = term ? await read(`limits-${term}.json`).catch(() => null) : null;
        if (mine) this.lastSession = mine;
        const isClaude = Boolean(term) && agents().some((a) => a.address === term && (a.app === "claude-code" || a.program?.key === "claude"));
        const next = !shared ? null
          : mine ? { ...shared, ...mine }
          : isClaude ? { ...shared, model: null, effort: null, ctx: null }
          : this.lastSession ? { ...shared, ...this.lastSession }
          : shared;
        if (JSON.stringify(next) !== JSON.stringify(this.limits)) {
          this.limits = next;
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

  // The chat in front of you, if the shown tab is a chat: the patched chat mod publishes its model, effort
  // and context under its tab id in shared "vnh.chat" while that tab is shown (patches/chat-vnh.patch).
  // A chat runs `claude -p`, which never calls the status line script, so the files can't describe it.
  liveChat() {
    const tab = focused()?.tab;
    return (tab ? (shared("vnh.chat") ?? {})[tab] : null) ?? null;
  }

  // The shown chat when it is a Claude one (the catalog is Claude's), else null: the menu then saves a default.
  liveClaudeChat() {
    const c = this.liveChat();
    return c && /claude|anthropic/i.test(c.provider ?? "") ? c : null;
  }

  claude(t) {
    const chat = this.liveChat();
    const l = chat ? { ...(this.limits ?? {}), model: chat.model, effort: chat.effort, ctx: chat.ctx } : this.limits;
    if (!l) return null;
    const row = h_flex().gap(10).items_center()
      .child(div().child("|"))
      .child(this.modelMenu(t, l));
    if (typeof l.five === "number") row.child(this.limit(t, l.five, "5h", l.five_reset));
    if (typeof l.seven === "number") row.child(this.limit(t, l.seven, "7d", l.seven_reset));
    if (typeof l.ctx === "number") row.child(this.limit(t, l.ctx, "ctx", null));
    return row;
  }

  // The model name as a dropup menu anchored to itself: click opens tier 1 (models); hovering a
  // model opens tier 2 (effort). The effort sits beside the model, no parentheses, dimmer than the
  // model. The content is built only while open, so the bar pays nothing for it on timer re-renders.
  modelMenu(t, l) {
    const trigger = h_flex().id("vnh-model").gap(5).items_center().cursor_pointer()
      .when(this.menuOpen, (el) => el.text_color(t.foreground))
      .hover((s) => s.text_color(t.foreground))
      .tooltip(this.liveClaudeChat() ? "Switch this chat's model · hover a model for its effort" : "Default model for new sessions · hover a model for its effort")
      // A Claude session that hasn't reported yet has no model: "…" instead of another session's.
      .child(div().child(l.model ?? "…"))
      .when(Boolean(l.effort), (el) => el.child(div().text_color(t.dim).child(l.effort)));
    return Popover.new("vnh-model-menu").anchor("bottom_left").open(this.menuOpen)
      .on_open_change((open, cx) => { this.menuOpen = open; cx.notify(); })
      .trigger(trigger)
      .when(this.menuOpen, (el) => el.content(this.modelMenuContent(t)));
  }

  // Tier-1 rows: "Default" (recommended), then the catalog's quick-pick models, then the saved default
  // model when it isn't one of them — each with its real version name, the saved default ticked.
  modelRows() {
    const models = this.catalog?.models ?? [];
    const quick = models.filter((m) => m.quick_select || m.section === "main");
    const rows = [{ id: "default", name: "Default", hint: "recommended", default: true, thinking: null }];
    for (const m of quick) rows.push(m);
    const cur = this.defaultModel();
    if (cur && !quick.some((m) => m.id === cur.id)) rows.push(cur);
    return rows;
  }

  modelMenuContent(t) {
    if (!this.catalog) return v_flex().w(190).p(4).rounded(8).border_1().border_color(t.border).bg(t.popover)
      .child(div().px(8).py(6).text_size(12).text_color(t.dim).child("Loading models…"));
    const live = this.liveClaudeChat(); // a Claude chat is shown: the menu switches it, ticks follow it
    const saved = this.defaultModel(); // null: no `model` saved, the account default
    const modelRow = (m) => {
      const on = live ? (m.name || "").toLowerCase() === String(live.model ?? "").toLowerCase() : m.default ? !saved : saved?.id === m.id;
      const efforts = m.thinking?.effort_options ?? [];
      const modelId = m.default ? "default" : m.id;
      const row = h_flex().id(`vm-${m.id}`).h(28).px(8).gap(8).items_center().rounded(5).cursor_pointer()
        .text_size(12).text_color(on ? t.foreground : t.muted)
        .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.choose(cx, modelId, null))
        .child(div().flex_1().child(m.name))
        .when(on, (el) => el.child(div().flex_none().text_color(t.accent).child("✓")))
        .when(m.hint === "recommended", (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("default")))
        .when(efforts.length > 0, (el) => el.child(div().flex_none().text_color(t.dim).child("›")));
      if (!efforts.length) return row;
      // This model's saved effort: what new sessions use, else the level Claude Code reports for it.
      const effortNow = live ? (on ? live.effort : null) : (this.defaults?.effort?.[m.id] ?? this.catalog.effortByModel[m.id] ?? null);
      const sub = v_flex().w(150).p(4).gap(1).ml(6).rounded(8).border_1().border_color(t.border).bg(t.popover)
        .child(div().px(8).py(3).text_size(10).text_color(t.dim).child("Effort"))
        .children(efforts.map((e) => {
          const eon = effortNow === e.id;
          return h_flex().id(`ve-${m.id}-${e.id}`).h(26).px(8).gap(6).items_center().rounded(5).cursor_pointer()
            .text_size(12).text_color(eon ? t.foreground : t.muted)
            .when(eon, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(cx, modelId, e.id))
            .child(div().flex_1().child(e.name))
            .when(Boolean(e.badge?.message), (el) => el.child(div().flex_none().text_size(10).text_color(e.badge.variant === "warning" ? t.ansi3 : t.dim).child(e.badge.message)));
        }));
      return HoverCard.new(`vm-hc-${m.id}`).anchor("right_center").open_delay(120).close_delay(250)
        .trigger(row).content(sub);
    };
    return v_flex().w(200).p(4).gap(1).rounded(8).border_1().border_color(t.border).bg(t.popover)
      .child(div().px(8).py(3).text_size(10).text_color(t.dim).child(live ? "Model · this chat" : "Model · new sessions"))
      .children(this.modelRows().map(modelRow));
  }

  // A pick: switches the shown Claude chat live (chat.setmodel, the chat's own control request: nothing is
  // typed anywhere), else saves the default for new sessions.
  choose(cx, modelId, effortId) {
    if (!this.liveClaudeChat()) return this.saveDefault(cx, modelId, effortId);
    this.menuOpen = false;
    cx.notify();
    const m = this.catalog?.models?.find((x) => x.id === modelId);
    const modelName = modelId === "default" ? "Default" : (m?.name ?? modelId);
    const effName = effortId ? (m?.thinking?.effort_options?.find((e) => e.id === effortId)?.name ?? effortId) : null;
    try {
      run(`chat.setmodel:${modelId}|${modelName}|${effortId ?? ""}`);
      notify({ title: `This chat → ${modelName}${effName ? ` · ${effName}` : ""}`, body: "Switched live. New sessions keep their default.", level: "success", timeout: 2500 });
    } catch (e) {
      notify({ title: "Couldn't switch this chat", body: String(e?.message ?? e).slice(0, 200), level: "error", timeout: 4000 });
    }
  }

  // Save the pick as the default for new sessions: edit `model` (and the model's `effortLevel`) in
  // ~/.claude/settings.json, keeping everything else, then show a corner toast. Nothing is sent to any
  // terminal. The write fails (and is retried once) if Claude Code changed the file in between.
  saveDefault(cx, modelId, effortId) {
    this.menuOpen = false;
    cx.notify();
    const m = this.catalog?.models?.find((x) => x.id === modelId);
    const modelName = modelId === "default" ? "Default" : (m?.name ?? modelId);
    const effName = effortId ? (m?.thinking?.effort_options?.find((e) => e.id === effortId)?.name ?? effortId) : null;
    const keepsEffort = !effortId || PERSISTED_EFFORTS.has(effortId);
    cx.spawn(async (cx) => {
      try {
        const path = home() + SETTINGS_FILE;
        for (let attempt = 0; ; attempt++) {
          const text = await readTextFile(path);
          const data = text ? JSON.parse(text) : {};
          if (modelId === "default") delete data.model; else data.model = modelId;
          if (effortId && keepsEffort && modelId !== "default") {
            data.modelSettings = { ...(data.modelSettings ?? {}), [modelId]: { ...(data.modelSettings?.[modelId] ?? {}), effortLevel: effortId } };
          }
          try { await writeTextFile(path, JSON.stringify(data, null, 2) + "\n", text); break; }
          catch (e) { if (attempt >= 1) throw e; }
        }
        await this.loadDefaults();
        cx.notify();
        notify({
          title: `New sessions → ${modelName}${effName ? ` · ${effName}` : ""}`,
          body: keepsEffort ? "Saved as the default. Running sessions keep their model."
            : "Model saved. Max isn't kept as a default (Claude Code only saves up to Extra): use /effort max inside a session.",
          level: keepsEffort ? "success" : "warning", timeout: 3500,
        });
      } catch (e) {
        notify({ title: "Couldn't save the default model", body: String(e?.message ?? e).slice(0, 200), level: "error", timeout: 4000 });
      }
    });
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const claude = this.claude(t);
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

// Cloudflare Deploys: Pages and Workers builds for the projects your spaces work in, so you
// know a deploy actually went live. It only reads from Cloudflare; it never deploys or changes anything.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, exec, readTextFile, home, theme, notify, props, shared, setShared, run, openOverlay, closeOverlay, window as appWindow } from "herdr";
import { createSources } from "./sources.js";
import { createDiscovery } from "./discover.js";
import { fetchAll } from "./fetch-project.js";
import { settingsFrom, parseDotenv } from "./parse.js";
import { ACTIVE, summarize, diffForNotifications, latestDeploy } from "./model.js";

const MOD = "cloudflare-deploys";
const TICK_MS = 5000;
const DISCOVER_MS = 60_000;
const SHARED_KEY = "cloudflare.status"; // small summary, for any mod
const DATA_KEY = "cloudflare.deploys"; // full results, for the popup
const REQUEST_KEY = "cloudflare.request"; // { at, signIn? }: the popup asks the poller to refresh
const POPUP_W = 400;
const POPUP_H = 520;

// Three ways to show this mod:
//   props { bar: true }  an icon in a header row; this copy polls Cloudflare and sends notifications
//   props { popup: true } the popup the icon opens; it only reads what the bar copy publishes
//   no props             a full side panel that polls on its own (use it instead of the bar, not with it)
const viewMode = () => {
  const p = props() ?? {};
  return p.bar ? "bar" : p.popup || p.overlay ? "popup" : "panel"; // mod.open opens the popup too
};
const configDir = () => `${home()}/.config/cloudflare-deploys`;
const configFile = () => `${configDir()}/.env`;

const TEMPLATE = `# Cloudflare Deploys settings (Herdr app mod and herdr TUI plugin).
# Projects are found from wrangler.toml / wrangler.json(c) in your spaces' folders.

# REST API (preferred). Leave blank to use the wrangler CLI and your \`wrangler login\`.
# Read-only token, Account permissions: Cloudflare Pages Read, Workers Scripts Read, Workers CI Read.
CF_API_TOKEN=
CF_ACCOUNT_ID=

# auto (API, then wrangler) | api | wrangler
CF_SOURCE=auto
# How to run wrangler when it isn't in the project or on PATH, e.g. npx wrangler
# CF_WRANGLER=

# Extra projects not in any space: pages:my-site,worker:my-api
# CF_PROJECTS=

CF_POLL_SECONDS=30
CF_POLL_ACTIVE_SECONDS=10
CF_DEPLOY_LIMIT=5
# failures | all | off
CF_NOTIFY=failures
`;

const icon = (name, size, color) => svg(`mods/${MOD}/${name}.svg`).size(size).flex_none().text_color(color);

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* best effort */ }
}

function opener() {
  const platform = appWindow()?.platform;
  return platform === "macos" ? "open" : platform === "windows" ? "explorer.exe" : "xdg-open";
}
function openExternal(url) {
  if (url) exec(opener(), [url]).catch(() => {});
}

function ago(iso, now) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const LABEL = {
  success: "ok", failed: "failed", building: "building", deploying: "deploying",
  queued: "queued", canceled: "canceled", skipped: "skipped", unknown: "unknown",
};
const label = (d) => (d.status === "success" && d.current ? "live" : LABEL[d.status] ?? d.status);

function statusColor(status, t) {
  if (status === "success") return t.ansi2;
  if (status === "failed") return t.ansi1;
  if (ACTIVE.has(status)) return t.working;
  return t.dim;
}

function statusMark(status, t) {
  const box = h_flex().size(16).flex_none().items_center().justify_center();
  if (status === "success") return box.child(icon("check", 13, t.ansi2));
  if (status === "failed") return box.child(icon("cross", 13, t.ansi1));
  if (ACTIVE.has(status)) return box.child(icon("spinner", 12, t.working).spin(900));
  return box.child(div().size(6).rounded(99).bg(t.dim));
}

/** A key for "the folders my spaces are in changed", to know when to look for projects again. */
function foldersKey() {
  const s = spaces().map((x) => `${x.id}:${x.machine ?? ""}:${x.folder}`);
  const p = panes().filter((x) => x.cwd).map((x) => `${x.tab}:${x.cwd}`);
  return [...s, ...p].join("|");
}

/** Discovered projects first, then CF_PROJECTS entries no space covers. */
function mergeProjects(discovered, configured) {
  const out = [...discovered];
  for (const p of configured) {
    if (!out.some((d) => d.kind === p.kind && d.name === p.name)) out.push({ ...p, dir: null, machine: null, spaces: [], spaceIds: [] });
  }
  return out;
}

async function loadSettings() {
  let text = null;
  try { text = await readTextFile(configFile()); } catch { text = null; }
  const file = parseDotenv(text ?? "");
  const p = props() ?? {};
  // Layout props win over the file, for people who keep settings with their layout.
  const fromProps = {
    CF_SOURCE: p.source, CF_PROJECTS: Array.isArray(p.projects) ? p.projects.join(",") : p.projects,
    CF_POLL_SECONDS: p.poll_seconds, CF_POLL_ACTIVE_SECONDS: p.active_poll_seconds,
    CF_DEPLOY_LIMIT: p.limit, CF_NOTIFY: p.notify,
  };
  const get = (...keys) => {
    for (const k of keys) {
      if (fromProps[k] != null && fromProps[k] !== "") return String(fromProps[k]);
      if (file[k]) return file[k];
    }
    return undefined;
  };
  return { ...settingsFrom(get), configFound: text != null };
}

export default class CloudflareDeploys extends View {
  init(_props, cx) {
    this.sources = createSources({ exec, fetch });
    this.discovery = createDiscovery({ readTextFile, exec, listPagesProjects: () => this.listPages() });
    this.pagesCache = { at: 0, list: null };
    this.discoverNotes = [];
    this.cfg = null;
    this.projects = [];
    this.results = [];
    this.folders = null;
    this.discoveredAt = 0;
    this.projectsKey = "";
    this.nextAt = 0;
    this.updatedAt = null;
    this.busy = false;
    this.error = null;
    this.notified = load("notified", {});
    this.folded = new Set(load("folded", []));
    this.mode = viewMode();
    if (this.mode === "popup") {
      cx.timer.every(30_000, (cx) => cx.notify()); // ages move on
      return;
    }
    this.requestSeen = shared(REQUEST_KEY)?.at ?? 0;
    this.tick(cx, true);
    cx.timer.every(TICK_MS, (cx) => this.tick(cx, false));
    cx.timer.every(30_000, (cx) => cx.notify()); // ages move on
  }

  tick(cx, force) {
    if (this.busy) return;
    const request = shared(REQUEST_KEY);
    if (request?.at > this.requestSeen) {
      this.requestSeen = request.at;
      if (request.signIn) this.afterSignIn();
      else force = true;
    }
    const now = Date.now();
    const folders = foldersKey();
    const rediscover = force || folders !== this.folders || now - this.discoveredAt > DISCOVER_MS;
    if (!rediscover && now < this.nextAt) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.cfg = await loadSettings();
        if (rediscover) {
          const found = await this.discovery.discover(spaces(), panes());
          this.projects = found.projects;
          this.discoverNotes = found.notes;
          this.discoveredAt = Date.now();
          this.folders = folders;
        }
        const all = mergeProjects(this.projects, this.cfg.projects);
        const key = all.map((p) => `${p.kind}:${p.name}`).join(",");
        // Rediscovery alone doesn't refetch unless the project set changed or a poll is due.
        if (force || key !== this.projectsKey || Date.now() >= this.nextAt) {
          this.projectsKey = key;
          this.results = await fetchAll(this.cfg, all, this.sources);
          this.updatedAt = Date.now();
          const running = this.results.some((r) => ACTIVE.has(r.deploys[0]?.status));
          this.nextAt = Date.now() + (running ? this.cfg.activePollSeconds : this.cfg.pollSeconds) * 1000;
          this.publish();
          this.alert();
        }
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.nextAt = Date.now() + 30_000;
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  /** Other mods (a status bar) can read shared("cloudflare.status"): { state, display, failed, running, projects }. */
  publish() {
    const summary = summarize(this.results);
    const value = {
      ...summary,
      failed: this.results.filter((r) => r.deploys[0]?.status === "failed").map((r) => r.project.name),
      running: this.results.filter((r) => ACTIVE.has(r.deploys[0]?.status)).map((r) => r.project.name),
      projects: this.results.map((r) => ({ kind: r.project.kind, name: r.project.name, status: r.deploys[0]?.status ?? null, source: r.source })),
    };
    const before = shared(SHARED_KEY);
    if (JSON.stringify(before ?? null) !== JSON.stringify(value)) setShared(SHARED_KEY, value);
    if (this.mode === "bar") {
      setShared(DATA_KEY, {
        results: this.results,
        updatedAt: this.updatedAt,
        notes: [...(this.cfg?.warnings ?? []), ...this.discoverNotes],
        configFound: Boolean(this.cfg?.configFound),
      });
    }
  }

  alert() {
    const { next, events } = diffForNotifications(this.notified, this.results, this.cfg.notify);
    this.notified = next;
    save("notified", next);
    for (const { level, project, deploy } of events) {
      const body = [deploy.branch, deploy.commit, deploy.message].filter(Boolean).join(" · ");
      notify(level === "failure"
        ? { title: `${project.name} deploy failed`, body, level: "error" }
        : { title: `${project.name} is live`, body, level: "success" });
    }
  }

  toggle(key) {
    if (this.folded.has(key)) this.folded.delete(key); else this.folded.add(key);
    save("folded", [...this.folded]);
  }

  /** The account's Pages projects (to match Git-connected ones to repos). API first, then wrangler; cached 10 min. */
  async listPages() {
    const cfg = this.cfg;
    if (this.pagesCache.list && Date.now() - this.pagesCache.at < 10 * 60_000) return this.pagesCache.list;
    let list = null;
    let authFailed = false;
    if (cfg.source !== "wrangler" && cfg.apiToken && cfg.accountId) {
      try { list = await this.sources.api.listPagesProjects(cfg); } catch (e) {
        if (cfg.source === "api") throw e;
        authFailed = e?.status === 401 || e?.status === 403;
      }
    }
    if (!list) list = await this.sources.wrangler.listPagesProjects(cfg, { dropToken: authFailed });
    this.pagesCache = { at: Date.now(), list };
    return list;
  }

  /** Opens `npx wrangler login` in a new tab (in a project folder, so a local wrangler is used). */
  signIn() {
    const projects = this.mode === "popup" ? (shared(DATA_KEY)?.results ?? []).map((r) => r.project) : this.projects;
    const dir = projects.find((p) => p.dir && !p.machine)?.dir;
    run("terminal.open", { argv: ["npx", "wrangler", "login"], place: "tab", name: "wrangler login", ...(dir ? { folder: dir } : {}) });
    if (this.mode === "popup") {
      setShared(REQUEST_KEY, { at: Date.now(), signIn: true });
      const overlay = props()?.overlay;
      if (overlay) closeOverlay(overlay);
    } else {
      this.afterSignIn();
    }
  }

  /** Look again ~20 s after a sign-in starts (the browser step), Pages project list included. */
  afterSignIn() {
    this.nextAt = Date.now() + 20_000;
    this.discoveredAt = Date.now() - DISCOVER_MS + 20_000;
    this.pagesCache = { at: 0, list: null };
  }

  /** Popup copies ask the polling copy to refresh; others refresh themselves. */
  refresh(cx) {
    if (this.mode === "popup") setShared(REQUEST_KEY, { at: Date.now() });
    else this.tick(cx, true);
  }

  signInButton(id, t, text) {
    return h_flex().id(id).flex_none().px(8).py(4).gap(6).items_center().rounded(6)
      .border(1).border_color(t.border).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); this.signIn(); })
      .child(icon("login", 12, t.muted))
      .child(div().text_size(11.5).text_color(t.foreground).child(text));
  }

  openSettings() {
    const script = 'mkdir -p "$1" && { [ -f "$2" ] || printf "%s" "$3" > "$2"; } && chmod 600 "$2" && $4 "$2"';
    const open = opener() === "open" ? "open -t" : opener();
    exec("sh", ["-c", script, "sh", configDir(), configFile(), TEMPLATE, open]).catch(() => {});
  }

  header(t, now) {
    const summary = summarize(this.results);
    const dot = summary.state === "failed" ? t.ansi1 : summary.state === "active" ? t.working : summary.state === "live" ? t.ansi2 : t.dim;
    const updated = this.busy ? "checking…" : this.updatedAt ? `updated ${ago(new Date(this.updatedAt).toISOString(), now)}` : "";
    return h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(icon("cloud", 15, t.muted))
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Cloudflare"))
      .when(this.results.length > 0, (el) => el.child(div().size(7).rounded(99).flex_none().bg(dot)))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(t.dim).child(updated))
      .child(h_flex().id("cf-login").size(24).flex_none().items_center().justify_center().rounded(5)
        .hover((s) => s.bg(t.hover)).on_click(() => this.signIn()).child(icon("login", 13, t.dim)))
      .child(h_flex().id("cf-settings").size(24).flex_none().items_center().justify_center().rounded(5)
        .hover((s) => s.bg(t.hover)).on_click(() => this.openSettings()).child(icon("settings", 13, t.dim)))
      .child(h_flex().id("cf-refresh").size(24).flex_none().items_center().justify_center().rounded(5)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.refresh(cx))
        .child(this.busy ? icon("spinner", 12, t.dim).spin(900) : icon("refresh", 13, t.dim)));
  }

  deployRow(r, d, i, t, now) {
    const where = [d.env, d.branch].filter(Boolean).join(" · ");
    const url = d.url || d.dashUrl;
    return h_flex().id(`cf-${r.project.kind}-${r.project.name}-${i}`).px(8).py(5).gap(8).items_start().rounded(6)
      .hover((s) => s.bg(t.hover)).when(Boolean(url), (el) => el.on_click(() => openExternal(url)))
      .child(div().pt(1).child(statusMark(d.status, t)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_none().text_size(12).font_semibold().text_color(statusColor(d.status, t)).child(label(d)))
          .child(div().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(where))
          .child(div().flex_1())
          .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(d.createdAt, now))))
        .when(Boolean(d.message || d.commit), (el) => el.child(h_flex().gap(6).min_w(0)
          .when(Boolean(d.commit), (row) => row.child(div().flex_none().text_size(11).text_color(t.dim).child(d.commit)))
          .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(d.message ?? "")))));
  }

  project(r, t, now) {
    const key = `${r.project.kind}:${r.project.name}`;
    const folded = this.folded.has(key);
    const latest = r.deploys[0];
    const note = !r.source ? "unavailable"
      : r.source === "wrangler" && r.project.kind === "worker" ? "wrangler · no build status" : r.source;
    const dash = r.deploys.find((d) => d.dashUrl)?.dashUrl;
    return v_flex().gap(2).pb(6)
      .child(h_flex().id(`cf-head-${key}`).px(8).py(4).gap(6).items_center().rounded(6)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.toggle(key); cx.notify(); })
        .child(div().flex_none().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.muted)
          .child(r.project.kind === "pages" ? "Pages" : "Workers"))
        .child(div().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(r.project.name))
        .when(folded && Boolean(latest), (el) => el.child(statusMark(latest.status, t)))
        .child(div().flex_1())
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(note))
        .when(Boolean(dash), (el) => el.child(h_flex().id(`cf-dash-${key}`).size(20).flex_none().items_center().justify_center()
          .rounded(4).hover((s) => s.bg(t.raised)).on_click((_e, cx) => { cx.stop_propagation(); openExternal(dash); })
          .child(icon("external", 11, t.dim)))))
      .when(!folded && r.project.spaces?.length > 0, (el) => el.child(
        div().px(8).truncate().text_size(10.5).text_color(t.dim).child(r.project.spaces.join(", "))))
      .when(!folded, (el) => el
        .children(r.errors.map((e, i) => div().id(`cf-err-${key}-${i}`).px(8).text_size(11)
          .text_color(r.source ? t.dim : t.ansi1).child(r.source ? `fell back · ${e}` : e)))
        .when(!r.source, (x) => x.child(h_flex().px(8).pt(2).child(this.signInButton(`cf-login-${key}`, t, "Sign in with wrangler"))))
        .when(Boolean(r.source) && r.deploys.length === 0, (x) => x.child(div().px(8).text_size(11.5).text_color(t.dim).child("No deployments yet")))
        .children(r.deploys.map((d, i) => this.deployRow(r, d, i, t, now))));
  }

  empty(t) {
    const configured = this.mode === "popup" ? shared(DATA_KEY)?.configFound : this.cfg?.configFound;
    return v_flex().p(14).gap(10)
      .child(div().text_size(12.5).text_color(t.foreground).child((this.busy && !this.cfg) || (this.mode === "popup" && !shared(DATA_KEY)) ? "Looking for Cloudflare projects…" : "No Cloudflare projects in your spaces"))
      .child(div().text_size(11.5).text_color(t.muted)
        .child("Open a space in a repo with a wrangler.toml or wrangler.json(c), or list projects as CF_PROJECTS in the settings file."))
      .child(div().text_size(11.5).text_color(t.muted)
        .child("Sign in with `wrangler login`, or add a read-only API token in settings for Workers build status."))
      .child(h_flex().gap(8).items_center()
        .child(this.signInButton("cf-login-empty", t, "Sign in with wrangler"))
        .child(h_flex().id("cf-open-settings").flex_none().px(8).py(4).gap(6).items_center().rounded(6)
          .border(1).border_color(t.border).hover((s) => s.bg(t.hover)).on_click(() => this.openSettings())
          .child(icon("settings", 12, t.muted))
          .child(div().text_size(11.5).text_color(t.foreground).child(configured ? "Open settings" : "Create settings file"))));
  }

  openPopup() {
    openOverlay({ mod: MOD, kind: "popup", props: { popup: true }, width: POPUP_W, height: POPUP_H, at: "pointer" });
  }

  /** The header icon: a cloud, plus a spinner while building, a red dot on failure, green when live. */
  renderBar(t, now) {
    const summary = summarize(this.results);
    const hero = latestDeploy(this.results);
    const color = summary.state === "failed" ? t.ansi1 : summary.state === "active" ? t.working
      : summary.state === "live" ? t.foreground : t.muted;
    const tip = this.error ? `Cloudflare: ${this.error}`
      : !hero ? (this.busy ? "Cloudflare: checking…" : "Cloudflare: no projects found")
      : `${hero.result.project.name}: ${label(hero.deploy)}` + [hero.deploy.branch, hero.deploy.commit, ago(hero.deploy.createdAt, now)]
        .filter(Boolean).map((x) => ` · ${x}`).join("");
    const marker = summary.state === "active" ? icon("spinner", 11, t.working).spin(900)
      : summary.state === "failed" ? div().size(7).rounded(99).bg(t.ansi1)
      : summary.state === "live" ? div().size(7).rounded(99).bg(t.ansi2)
      : summary.state === "error" ? div().size(7).rounded(99).bg(t.ansi3) : null;
    // VNH: no bottom border (the brand row beside it has none, so a line under the icon alone looked like a gap).
    return h_flex().id("cf-bar").size_full().px(4).items_center().justify_center().bg(t.chrome)
      .child(h_flex().id("cf-btn").h(26).px(8).gap(6).rounded(5).items_center().cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip(tip)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => this.openPopup())
        .child(icon("cloud", 16, color))
        .when(Boolean(marker), (el) => el.child(marker)));
  }

  /** The most recent build, large: status, project, branch, commit, message, links. */
  heroCard(r, d, t, now) {
    const color = statusColor(d.status, t);
    const where = [d.env, d.branch].filter(Boolean).join(" · ");
    const button = (id, text, url) => h_flex().id(id).px(10).py(5).gap(6).items_center().rounded(6)
      .border(1).border_color(t.border).hover((s) => s.bg(t.hover)).on_click(() => openExternal(url))
      .child(div().text_size(11.5).text_color(t.foreground).child(text)).child(icon("external", 11, t.dim));
    return v_flex().mx(10).mt(10).mb(4).p(14).gap(8).rounded(10).bg(color + "14").border(1).border_color(color + "55")
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(10.5).text_color(t.dim).child(ACTIVE.has(d.status) ? "BUILDING NOW" : "LATEST BUILD"))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(d.createdAt ? `${ago(d.createdAt, now)} ago`.replace("now ago", "just now") : "")))
      .child(h_flex().gap(10).items_center()
        .child(h_flex().size(28).flex_none().items_center().justify_center().rounded(99).bg(color + "26")
          .child(ACTIVE.has(d.status) ? icon("spinner", 16, color).spin(900)
            : icon(d.status === "failed" ? "cross" : d.status === "success" ? "check" : "spinner", 16, color)))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().text_size(16).font_semibold().text_color(color).child(label(d)))
          .child(h_flex().gap(6).items_center().min_w(0)
            .child(div().flex_none().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.muted)
              .child(r.project.kind === "pages" ? "Pages" : "Workers"))
            .child(div().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(r.project.name)))))
      .when(Boolean(where || d.commit), (el) => el.child(h_flex().gap(8).items_center().min_w(0)
        .when(Boolean(where), (x) => x.child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(where)))
        .when(Boolean(d.commit), (x) => x.child(div().flex_none().px(5).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(d.commit)))))
      .when(Boolean(d.message), (el) => el.child(div().text_size(12).text_color(t.foreground).truncate().child(d.message)))
      .when(Boolean(d.url || d.dashUrl), (el) => el.child(h_flex().gap(8).pt(2)
        .when(Boolean(d.url), (x) => x.child(button("cf-hero-site", "Open site", d.url)))
        .when(Boolean(d.dashUrl), (x) => x.child(button("cf-hero-dash", "Dashboard", d.dashUrl)))));
  }

  renderPopup(t, now) {
    const data = shared(DATA_KEY) ?? {};
    const results = data.results ?? [];
    const hero = latestDeploy(results);
    const updated = data.updatedAt ? `updated ${ago(new Date(data.updatedAt).toISOString(), now)}` : "waiting for the header icon…";
    const notes = data.notes ?? [];
    const iconButton = (id, name, onClick) => h_flex().id(id).size(24).flex_none().items_center().justify_center().rounded(5)
      .hover((s) => s.bg(t.hover)).on_click(onClick).child(icon(name, 13, t.dim));
    // Popups size to their content, so give it a real size (size_full would collapse to the header).
    return v_flex().id("cf-popup").w(POPUP_W).h(POPUP_H)
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(icon("cloud", 15, t.muted))
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Cloudflare"))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(updated))
        .child(iconButton("cf-p-login", "login", () => this.signIn()))
        .child(iconButton("cf-p-settings", "settings", () => this.openSettings()))
        .child(iconButton("cf-p-refresh", "refresh", (_e, cx) => this.refresh(cx))))
      .child(v_flex().id("cf-p-list").flex_1().min_h(0).overflow_y_scrollbar().pb(8)
        .when(Boolean(hero), (el) => el.child(this.heroCard(hero.result, hero.deploy, t, now)))
        .when(results.length === 0, (el) => el.child(this.empty(t)))
        .when(results.length > 0, (el) => el.child(v_flex().px(6).pt(6).gap(2)
          .child(div().px(8).pb(2).text_size(10.5).text_color(t.dim).child("ALL PROJECTS"))
          .children(results.map((r) => this.project(r, t, now))))))
      .when(notes.length > 0, (el) => el.child(v_flex().flex_none().px(12).py(6).gap(2).border_t(1).border_color(t.border)
        .children(notes.map((w, i) => div().id(`cf-p-note-${i}`).truncate().text_size(11).text_color(t.ansi3).child(w)))));
  }

  render(_cx) {
    const t = theme();
    const now = Date.now();
    if (this.mode === "bar") return this.renderBar(t, now);
    if (this.mode === "popup") return this.renderPopup(t, now);
    const warnings = [...(this.cfg?.warnings ?? []), ...this.discoverNotes, ...(this.error ? [this.error] : [])];
    return v_flex().id("cf-root").size_full()
      .child(this.header(t, now))
      .child(v_flex().id("cf-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .when(this.results.length === 0, (el) => el.child(this.empty(t)))
        .children(this.results.map((r) => this.project(r, t, now))))
      .when(warnings.length > 0, (el) => el.child(v_flex().flex_none().px(12).py(6).gap(2).border_t(1).border_color(t.border)
        .children(warnings.map((w, i) => div().id(`cf-warn-${i}`).truncate().text_size(11).text_color(t.ansi3).child(w)))));
  }
}

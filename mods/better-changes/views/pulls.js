// VNH: the PRs tab. A list of the open pull requests of the repository (this branch's first), a filter (Mine / Review / All),
// and a detail view with what stands between the PR and a merge: checks, reviews, the verdict, the files it changes.
// Every action (merge, checkout, send to the agent…) is in the right-click / ⋮ menu of vnh-changes-menu. All reads go through gh.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, openOverlay } from "herdr";
import { timeAgo } from "./../git/model.js";
import { TEXT, codeFont, Icon, FileIcon, PanelHeader, IconButton, TextButton, GroupHeader, Row, DiffStat, Message } from "./ui.js";
import { readPrCode, TRUNKS, summarize, readiness, reviewLabel, loginOf, authorOf, atOf, forgeOf, listPulls, whoami, pullDetail, isMine, isAskedOf, createUrl } from "../git/pulls.js";

const FRESH_MS = 60000; // a list this young is not read again when the tab is shown
const CAP_CHECKS = 60, CAP_FILES = 150;

const colorOf = (t, tone) => ({ good: t.ansi2, bad: t.ansi1, warn: t.ansi3, merged: t.ansi5, dim: t.dim })[tone] ?? t.dim;
function stateOf(t, pr) {
  if (pr.state === "MERGED") return ["pr-merged", t.ansi5];
  if (pr.state === "CLOSED") return ["pr-closed", t.ansi1];
  if (pr.isDraft) return ["pr-draft", t.dim];
  return ["pr-open", t.ansi2];
}
// GitHub markdown cut to something a narrow panel can show as plain text.
function plainBody(text) {
  const s = String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > 20000 ? `${s.slice(0, 20000).trimEnd()}…` : s;
}

export const pullsMethods = {
  // ── Reading ────────────────────────────────────────────────────────────────

  resetPulls() {
    this.prs = null;
    this.prBranch = null;
    this.prsAt = 0;
    this.prsError = null;
    this.prsLoading = false;
    this.prsDone = null;
    this.prsDoneAt = 0;
    this.prsDoneError = null;
    this.prsDoneLoading = false;
    this.selectedPr = null;
    this.prDetail = null;
    this.prToken = (this.prToken ?? 0) + 1;
  },

  // Where this repository's pull requests live (GitHub or Azure DevOps), or null.
  forge() {
    if (this.forgeKey !== `${this.origin}|${this.repo}`) { this.forgeKey = `${this.origin}|${this.repo}`; this.forgeValue = forgeOf(this.origin, this.repo); }
    return this.forgeValue;
  },

  // The open pull requests, the one of this branch (open or not), and who "me" is. `force` ignores how fresh the list is.
  loadPulls(cx, force = false) {
    if (!this.root || this.prsLoading) return;
    // A failure counts as a read too, so a poll doesn't call gh again and again.
    const forge = this.forge();
    if (!forge) {
      const msg = "This repository's origin isn't on GitHub or Azure DevOps.";
      if (this.prsError !== msg) { this.prsError = msg; cx.notify(); }
      return;
    }
    if (!force && Date.now() - this.prsAt < FRESH_MS) return;
    const { root, on, branch, context } = this;
    this.prsLoading = true;
    this.prsError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const [list, me, head] = await Promise.all([
          listPulls(forge, root, on),
          this.prMe ?? whoami(forge, root, on),
          branch && !TRUNKS.has(branch) ? listPulls(forge, root, on, { branch }).catch(() => []) : [],
        ]);
        if (!this.isCurrent(context)) return;
        this.prs = list ?? [];
        this.prMe = me;
        this.prBranch = head?.[0] ?? null;
        this.prsAt = Date.now();
        // The open one follows the new list (its checks moved on).
        if (this.selectedPr) {
          const fresh = this.prs.find((p) => p.number === this.selectedPr.number) ?? (this.prBranch?.number === this.selectedPr.number ? this.prBranch : null);
          if (fresh) this.selectedPr = fresh;
          else this.openPr(this.selectedPr, cx); // merged or closed meanwhile: its own state
        }
      } catch (e) {
        if (this.isCurrent(context)) this.prsError = e.message;
      } finally {
        this.prsAt = Date.now();
        this.prsLoading = false;
        if (this.prFilter === "done") this.loadDone(cx, force); // restored from last time, or the refresh button
        cx.notify();
      }
    });
  },

  // The merged / closed ones, read when the Completed chip is chosen (and again with the refresh button).
  loadDone(cx, force = false) {
    const forge = this.forge();
    if (!this.root || !forge || this.prsDoneLoading) return;
    if (!force && this.prsDone && Date.now() - this.prsDoneAt < FRESH_MS) return;
    const { root, on, context } = this;
    this.prsDoneLoading = true;
    this.prsDoneError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const list = await listPulls(forge, root, on, { done: true });
        if (this.isCurrent(context)) this.prsDone = list ?? [];
      } catch (e) {
        if (this.isCurrent(context)) this.prsDoneError = e.message;
      } finally {
        this.prsDoneAt = Date.now();
        this.prsDoneLoading = false;
        cx.notify();
      }
    });
  },

  openPr(pr, cx) {
    this.selectedPr = pr;
    this.prDetail = null;
    this.prDetailError = null;
    this.prDetailLoading = true;
    const token = ++this.prToken;
    const { root, on, context } = this, forge = this.forge();
    this.loadPrCode(pr, cx);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const d = await pullDetail(forge, pr, root, on);
        if (token === this.prToken && this.isCurrent(context)) this.prDetail = d;
      } catch (e) {
        if (token === this.prToken) this.prDetailError = `${forge?.kind === "azure" ? "az" : "gh"}: ${e.message}`; // which CLI said it
      } finally {
        if (token === this.prToken) this.prDetailLoading = false;
        cx.notify();
      }
    });
  },

  // The PR's code: its head and base are fetched, and the files it changes listed (a click opens a file's diff in the centre).
  loadPrCode(pr, cx) {
    const forge = this.forge(), token = this.prToken, { context } = this;
    this.prCode = { number: pr.number, loading: true, files: [], base: null, head: null, error: null };
    cx.spawn(async (cx) => {
      try {
        const r = await readPrCode((args) => this.git(args), forge, pr);
        if (token === this.prToken && this.isCurrent(context)) this.prCode = { number: pr.number, loading: false, error: null, ...r };
      } catch (e) {
        if (token === this.prToken) this.prCode = { number: pr.number, loading: false, files: [], base: null, head: null, error: e.message };
      } finally {
        cx.notify();
      }
    });
  },

  closePr(cx) {
    this.selectedPr = null;
    this.prDetail = null;
    this.prCode = null;
    this.prToken++;
    cx.notify();
  },

  setPrFilter(filter, cx) {
    this.prFilter = filter;
    localStorage.setItem("vnh-pr-filter", filter);
    if (filter === "done") this.loadDone(cx);
    cx.notify();
  },

  // ── The menu (vnh-changes-menu) ────────────────────────────────────────────

  prProps(pr, extra = {}) {
    const merged = pr.number === this.selectedPr?.number ? { ...pr, ...(this.prDetail ?? {}) } : pr;
    const c = summarize(merged.statusCheckRollup);
    return {
      kind: "pr", root: this.root, on: this.on ?? null, forge: this.forge(),
      number: pr.number, title: pr.title, url: pr.url, state: pr.state, isDraft: Boolean(pr.isDraft),
      headRef: pr.headRefName, baseRef: pr.baseRefName, oid: merged.headRefOid ?? pr.headRefOid ?? "",
      mine: isMine(pr, this.prMe), failed: c.failed.slice(0, 12).map((f) => ({ name: f.name, url: f.url })),
      verdict: readiness(merged, c).text, ...extra,
    };
  },

  openPrMenu(pr, extra = {}) {
    openOverlay({ mod: "vnh-changes-menu", kind: "popup", width: 270, height: 470, props: this.prProps(pr, extra) });
  },

  // ── The list ───────────────────────────────────────────────────────────────

  prCounts() {
    const all = this.prs ?? [], me = this.prMe;
    return {
      all,
      mine: all.filter((p) => isMine(p, me)),
      review: all.filter((p) => isAskedOf(p, me)),
    };
  },

  renderPulls() {
    const t = theme();
    if (this.selectedPr) return this.renderPr();
    const wrap = v_flex().id("prs").flex_1().min_h(0);
    const list = v_flex().id("pr-list").flex_1().min_h(0).overflow_y_scrollbar().p(6);
    if (this.prsError && !this.prs) return wrap.child(list.child(Message(this.prsError, true)));
    if (!this.prs) return wrap.child(list.child(Message(this.prsLoading ? "Loading pull requests…" : "No pull requests loaded")));

    const groups = this.prCounts();
    const filter = ["mine", "review", "all", "done"].includes(this.prFilter) ? this.prFilter : "all";
    const chip = (id, label) =>
      TextButton({ id: `prf-${id}`, label: id === "done" ? label : `${label} ${groups[id].length}`, active: filter === id, onClick: (cx) => this.setPrFilter(id, cx) });
    wrap.child(
      h_flex().flex_none().px(8).py(5).gap(4).items_center().border_b(1).border_color(t.border)
        .child(chip("mine", "Mine")).child(chip("review", "Review")).child(chip("all", "All")).child(chip("done", "Completed"))
        .child(div().flex_1())
        .when(Boolean(this.prsError), (el) => el.child(div().text_size(TEXT.caption).text_color(t.ansi1).tooltip(this.prsError).child("offline"))),
    );

    // This branch first: its pull request, or the way to open one.
    const here = this.prBranch;
    if (here || (this.branch && !TRUNKS.has(this.branch))) {
      list.child(GroupHeader({ id: "pr-here", label: this.branch ?? "This branch", detail: here ? null : "no pull request" }));
      if (here) list.child(this.prRow(here));
      else
        list.child(
          h_flex().id("pr-create").flex_none().px(8).h(30).gap(8).items_center().rounded(7).cursor_pointer()
            .hover((s) => s.bg(t.hover)).text_size(TEXT.small).text_color(t.muted)
            .on_click((_e, cx) => cx.open_url(createUrl(this.forge(), this.branch)))
            .child(Icon("pr-open", 14).text_color(t.dim))
            .child(div().flex_1().truncate().child(`Open a pull request for ${this.branch}`))
            .child(Icon("external-link", 12).text_color(t.dim)),
        );
    }

    if (filter === "done") {
      list.child(GroupHeader({ id: "pr-done", label: "Merged and closed", count: this.prsDone?.length, divided: Boolean(here || this.branch) }));
      if (this.prsDoneError) list.child(Message(this.prsDoneError, true));
      else if (!this.prsDone) list.child(Message("Loading completed pull requests…"));
      else if (!this.prsDone.length) list.child(Message("Nothing merged or closed yet"));
      for (const pr of this.prsDone ?? []) list.child(this.prRow(pr));
      return wrap.child(list);
    }
    const shown = groups[filter].filter((p) => p.number !== here?.number);
    list.child(GroupHeader({ id: "pr-open", label: filter === "mine" ? "Opened by you" : filter === "review" ? "Waiting for your review" : "Open", count: shown.length, divided: Boolean(here || this.branch) }));
    if (!shown.length) list.child(Message(filter === "all" ? "No open pull requests" : filter === "mine" ? "None of yours is open" : "Nobody is waiting for you"));
    for (const pr of shown) list.child(this.prRow(pr));
    return wrap.child(list);
  },

  prRow(pr) {
    const t = theme();
    const c = summarize(pr.statusCheckRollup), rd = readiness(pr, c), [icon, color] = stateOf(t, pr);
    const badge = !c.total ? null
      : c.fail ? [Icon("x", 12), t.ansi1, String(c.fail)]
      : c.run ? [Icon("dot", 12), t.ansi3, String(c.run)]
      : [Icon("check", 12), t.ansi2, ""];
    return h_flex()
      .id(`pr-${pr.number}`)
      .flex_none().px(8).py(6).gap(8).items_center().rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openPr(pr, cx))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openPrMenu(pr); })
      .child(Icon(icon, 15).text_color(color))
      .child(
        v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().child(pr.title))
          .child(
            h_flex().gap(6).items_center().min_w(0).text_size(TEXT.caption).text_color(t.dim)
              .child(div().flex_none().font_family(codeFont()).child(`#${pr.number}`))
              .child(div().flex_1().min_w(0).truncate().child(`${authorOf(pr)} · ${timeAgo(atOf(pr))}`))
              .child(div().flex_none().text_color(colorOf(t, rd.tone)).child(rd.text)),
          ),
      )
      .when(Boolean(badge), (el) =>
        el.child(h_flex().flex_none().gap(2).items_center().text_size(TEXT.caption).text_color(badge[1]).child(badge[0].text_color(badge[1])).child(badge[2])),
      );
  },

  // ── One pull request ───────────────────────────────────────────────────────

  renderPr() {
    const t = theme();
    const pr = { ...this.selectedPr, ...(this.prDetail ?? {}) };
    const checks = summarize(pr.statusCheckRollup), rd = readiness(pr, checks);
    const top = PanelHeader().px(8).gap(4)
      .child(IconButton({ id: "pr-back", icon: "chevron-left", label: "Back to pull requests", onClick: (cx) => this.closePr(cx) }))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.small).text_color(t.dim).font_family(codeFont()).child(`#${pr.number}`))
      .child(IconButton({ id: "pr-web", icon: "external-link", label: "Open on GitHub", onClick: (cx) => cx.open_url(pr.url) }))
      .child(IconButton({ id: "pr-more", icon: "more", label: "Actions", onClick: () => this.openPrMenu(this.selectedPr) }));

    const [icon, color] = stateOf(t, pr);
    const about = v_flex().id("pr-about").flex_none().px(14).py(10).gap(6).border_b(1).border_color(t.border)
      .child(div().font_medium().whitespace_normal().child(pr.title))
      .child(
        h_flex().gap(6).items_center().flex_wrap()
          .child(h_flex().gap(4).items_center().px(6).py(1).rounded(10).bg(color + "26").text_size(TEXT.caption).text_color(color)
            .child(Icon(icon, 12).text_color(color)).child(pr.state === "OPEN" && pr.isDraft ? "Draft" : pr.state[0] + pr.state.slice(1).toLowerCase()))
          .child(div().text_size(TEXT.caption).text_color(t.dim).whitespace_normal()
            .child(`${authorOf(pr)} · ${timeAgo(atOf(pr))} · ${pr.headRefName} → ${pr.baseRefName}`)),
      );
    if ((pr.labels ?? []).length)
      about.child(h_flex().gap(4).flex_wrap().children(pr.labels.slice(0, 8).map((l) =>
        div().px(6).rounded(8).bg(t.hover).text_size(TEXT.badge).text_color(t.muted).child(l.name))));
    const body = plainBody(pr.body);
    // A long description scrolls in a box of its own, so the checks and files stay in view.
    if (body)
      about.child(
        v_flex().id("pr-body").flex_none().max_h(150).overflow_y_scrollbar().mt(2).pr(4)
          .child(div().text_size(TEXT.small).text_color(t.muted).whitespace_normal().child(body)),
      );
    if (pr.additions || pr.deletions)
      about.child(h_flex().gap(8).items_center().text_size(TEXT.caption).text_color(t.dim)
        .child(DiffStat({ add: pr.additions, del: pr.deletions })).child(`${pr.changedFiles ?? (pr.files ?? []).length} files`));

    // Quick actions: the ones the verdict asks for. Everything else is in ⋮.
    const open = pr.state === "OPEN";
    const bar = h_flex().gap(6).flex_wrap().pt(2);
    if (checks.fail) bar.child(TextButton({ id: "pr-fix", icon: "sparkles", label: "Fix with agent", onClick: () => this.openPrMenu(this.selectedPr, { auto: "fix" }) }));
    if (open) bar.child(TextButton({ id: "pr-review", icon: "sparkles", label: "Review with agent", onClick: () => this.openPrMenu(this.selectedPr, { auto: "review" }) }));
    if (open && !pr.isDraft) bar.child(TextButton({ id: "pr-merge", icon: "check", label: "Merge…", onClick: () => this.openPrMenu(this.selectedPr, { ask: "merge-squash" }) }));
    if (open) about.child(bar);

    // The description has a scroll of its own, so it sits above the list that scrolls (a scroll inside a scroll doesn't turn).
    const scroll = v_flex().id("pr-scroll").flex_1().min_h(0).overflow_y_scrollbar()
      .child(this.renderPrStatus(pr, checks, rd))
      .child(this.renderPrChecks(checks))
      .child(this.renderPrFiles(pr));
    return v_flex().id("pr-detail").flex_1().min_h(0).child(top).child(about).child(scroll);
  },

  statusRow(id, icon, color, text, detail, onClick) {
    const t = theme();
    return h_flex().id(id).flex_none().px(8).h(26).gap(8).items_center().rounded(6).text_size(TEXT.small)
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
      .child(Icon(icon, 13).text_color(color))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(text))
      .when(Boolean(detail), (el) => el.child(div().flex_none().max_w(150).truncate().text_size(TEXT.caption).text_color(t.dim).child(detail)));
  },

  // The three questions of a merge: the verdict, the reviews, the checks' totals.
  renderPrStatus(pr, c, rd) {
    const t = theme();
    const box = v_flex().id("pr-status").flex_none().p(6).gap(1);
    const tone = rd.tone === "merged" ? "merged" : rd.tone;
    box.child(this.statusRow("pr-verdict", { good: "check", bad: "x", warn: "dot", dim: "dot", merged: "pr-merged" }[tone] ?? "dot", colorOf(t, tone), rd.text,
      pr.mergeable === "CONFLICTING" ? "resolve the conflicts" : pr.mergeStateStatus === "BEHIND" ? "update the branch" : ""));
    const decision = reviewLabel[pr.reviewDecision];
    box.child(this.statusRow("pr-decision", decision?.[1] === "good" ? "check" : decision?.[1] === "bad" ? "x" : "dot", colorOf(t, decision?.[1] ?? "dim"), decision?.[0] ?? "No review required", ""));
    for (const r of this.prDetail?.latestReviews ?? []) {
      const word = { APPROVED: "approved", CHANGES_REQUESTED: "asked for changes", COMMENTED: "commented", DISMISSED: "dismissed" }[r.state] ?? r.state.toLowerCase();
      const tn = r.state === "APPROVED" ? "good" : r.state === "CHANGES_REQUESTED" ? "bad" : "dim";
      box.child(this.statusRow(`pr-rv-${loginOf(r.author)}`, tn === "good" ? "check" : tn === "bad" ? "x" : "dot", colorOf(t, tn), `${loginOf(r.author)} ${word}`, ""));
    }
    for (const r of pr.reviewRequests ?? [])
      box.child(this.statusRow(`pr-rq-${loginOf(r)}`, "dot", t.ansi3, `${loginOf(r)} hasn't reviewed`, ""));
    if (this.prDetailLoading && !this.prDetail) box.child(div().px(8).h(22).text_size(TEXT.caption).text_color(t.dim).child("Loading reviews…"));
    if (this.prDetailError) box.child(div().px(8).text_size(TEXT.caption).text_color(t.ansi1).whitespace_normal().child(this.prDetailError));
    return box;
  },

  renderPrChecks(c) {
    const t = theme();
    if (!c.total) return div();
    const box = v_flex().id("pr-checks").flex_none().p(6).gap(1);
    const head = c.fail ? `${c.fail} failing` : c.run ? `${c.run} running` : `All ${c.total} passed`;
    box.child(GroupHeader({
      id: "pr-checks-h", label: "Checks", count: c.total, detail: c.fail || c.run ? `${c.pass} of ${c.total} passed` : head,
      danger: c.fail > 0, collapsed: !this.prShowPassed && !c.fail && !c.run, onClick: (cx) => { this.prShowPassed = !this.prShowPassed; cx.notify(); },
    }));
    // Failing and running checks are always listed; the passed ones only after "Show passed" (or opening the header).
    const rows = this.prShowPassed ? [...c.failed, ...c.running, ...c.all.filter((x) => x.state === "pass")] : [...c.failed, ...c.running];
    for (const x of rows.slice(0, CAP_CHECKS))
      box.child(this.statusRow(`pr-ck-${x.workflow}-${x.name}`, x.state === "fail" ? "x" : x.state === "run" ? "dot" : "check",
        x.state === "fail" ? t.ansi1 : x.state === "run" ? t.ansi3 : t.ansi2, x.name, x.workflow, x.url ? (cx) => cx.open_url(x.url) : null));
    if (!this.prShowPassed && c.pass && (c.fail || c.run))
      box.child(h_flex().id("pr-show-passed").px(8).h(24).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .text_size(TEXT.caption).text_color(t.dim).on_click((_e, cx) => { this.prShowPassed = true; cx.notify(); }).child(`Show ${c.pass} passed`));
    return box;
  },

  renderPrFiles(pr) {
    const t = theme();
    const code = this.prCode?.number === pr.number ? this.prCode : null;
    const box = v_flex().id("pr-files").flex_none().p(6);
    if (code?.files.length) {
      box.child(GroupHeader({ id: "pr-files-h", label: "Files changed", count: code.files.length, divided: true }));
      this.addRows(box, "pr", code.files.slice(0, CAP_FILES));
      if (code.files.length > CAP_FILES) box.child(Message(`…and ${code.files.length - CAP_FILES} more: see them on the web page`));
      return box;
    }
    if (code?.loading) return box.child(GroupHeader({ id: "pr-files-h", label: "Files changed", divided: true })).child(Message("Fetching the code…"));
    // The code could not be fetched (a fork, a deleted branch, no access): what the host lists, opening its web page.
    box.child(GroupHeader({ id: "pr-files-h", label: "Files changed", count: (pr.changedFiles ?? (pr.files ?? []).length) || undefined, divided: true }));
    if (code?.error) box.child(div().px(8).py(4).text_size(TEXT.caption).text_color(t.ansi1).whitespace_normal().child(code.error));
    for (const f of (pr.files ?? []).slice(0, CAP_FILES)) {
      const parts = f.path.split("/"), name = parts.pop();
      box.child(
        Row({ id: `pr-f-${f.path}`, onClick: (cx) => cx.open_url(`${pr.url}/files`) })
          .child(FileIcon({ icons: this.fileIcons, path: `${this.root}/${f.path}`, color: t.muted, t }))
          .child(h_flex().flex_1().min_w(0).gap(6).items_center()
            .child(div().max_w(190).flex_none().truncate().child(name))
            .child(div().flex_1().min_w(0).truncate().text_size(TEXT.small).text_color(t.dim).child(parts.join("/"))))
          .child(DiffStat({ add: f.additions, del: f.deletions })),
      );
    }
    return box;
  },
};

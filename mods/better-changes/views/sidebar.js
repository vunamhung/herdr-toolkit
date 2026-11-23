// Modified for herdr-toolkit from munza/herdr-mods `better-changes` (Apache-2.0). See THIRD-PARTY-NOTICES.md.
// The sidebar: its tabs, options menu, file groups and commit views.
import { div } from "gpui-kit";
import { v_flex, h_flex, v_resizable, resizable_panel } from "gpui-base";
import { theme, shared, setShared, exec, agents, spaces, notify, openOverlay, home } from "herdr";
import { fileTree, timeAgo } from "../git/model.js";
import {
  TEXT,
  SPIN_MS,
  codeFont,
  FileIcon,
  Chevron,
  Panel,
  PanelHeader,
  HeaderTab,
  RailButton,
  IconButton,
  TextButton,
  GroupHeader,
  Row,
  DiffStat,
  StatusLetter,
  Message,
  Menu,
  MenuLabel,
  MenuDivider,
  MenuOption,
  Icon,
  TextBox,
  SplitButton,
  SplitTrigger,
} from "./ui.js";

// VNH: AI commit messages (generateMessage).
const COMMIT_PROMPT = [
  "Write a git commit message for the staged changes below, following Conventional Commits 1.0.0.",
  "First line: type(scope): summary. type is one of feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert.",
  "scope is optional, short and lowercase (the area touched). summary is imperative mood, lowercase, no trailing period, at most 72 characters.",
  "Then, only if it helps a reviewer, a blank line and a short body of '- ' bullets on what changed and why, wrapped at 72 columns.",
  "Add a 'BREAKING CHANGE: ...' footer only when the change breaks a public API, and mark the type with '!'.",
  "Write in English. Output only the commit message: no code fences, no quotes, no commentary.",
].join("\n");
const GENERATE_SCRIPT = `
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$PATH:$d"; done # last: only for codex; claude stays ~/.local/bin
[ -n "$(git diff --cached --name-only)" ] || exit 3
log=$(git log -8 --format=%s 2>/dev/null)
diff=$(git -c core.quotePath=false diff --cached --stat --no-color; echo; git diff --cached --no-color -U2 | head -c 60000)
input=$(printf '%s\n\nRecent commit subjects in this repository (match their style):\n%s\n\nStaged changes:\n%s\n' "$2" "$log" "$diff")
if [ "$1" = codex ]; then
  command -v codex >/dev/null || { echo "codex not found" >&2; exit 127; }
  out=$(mktemp); printf '%s' "$input" | codex exec --skip-git-repo-check --color never -o "$out" - >/dev/null 2>&1; s=$?; cat "$out"; rm -f "$out"; exit $s
fi
command -v claude >/dev/null || { echo "claude not found" >&2; exit 127; }
printf '%s' "$input" | claude -p --model haiku
`;
// Drops code fences and a leading "Commit message:" the model may add.
function cleanMessage(raw) {
  let text = String(raw ?? "").replace(/\r/g, "").trim();
  text = text.replace(/^\x60\x60\x60[a-z]*\n?/i, "").replace(/\n?\x60\x60\x60\s*$/, "").trim();
  text = text.replace(/^(commit message|message)\s*:\s*/i, "").trim();
  return text;
}

// VNH: how many files a group draws at first, and how many more each click on "Show more" adds.
const ROW_CAP = 150, ROW_MORE = 300;
const VIEWS = [
  { id: "flat", label: "Flat", icon: "flat" },
  { id: "columns", label: "Columns", icon: "columns" }, // VNH
  { id: "tree", label: "Tree", icon: "tree" },
];
const LAYOUTS = [
  { id: "inline", label: "Inline", icon: "diff-inline" },
  { id: "split", label: "Side by side", icon: "diff-split" },
];

export const sidebarMethods = {
  // ── Preferences ───────────────────────────────────────────────────────────

  setTab(tab, cx) {
    this.tab = tab;
    this.pendingPr = this.pendingCommit = null;
    localStorage.setItem("tab", tab);
    this.saveUi();
    if (tab === "commit") this.loadCommits(cx);
    if (tab === "pr") this.loadPulls(cx);
    cx.notify();
  },

  setStaging(staging, cx) {
    this.staging = staging;
    localStorage.setItem("vnh-staging", staging);
    cx.notify();
  },

  setSessionOnly(on, cx) {
    this.sessionOnly = on;
    localStorage.setItem("vnh-session-only", on ? "1" : "0");
    this.saveUi();
    cx.notify();
  },

  // VNH: the files the agent in view wrote, as paths relative to the repository, or null when nothing is filtered (the option is off, or
  // no agent is in view). Fed by the Files panel (vnh-filetree), which sees every Claude and agy write.
  sessionPaths() {
    if (!this.sessionOnly || !this.mine || !this.root) return null;
    // Only what the ledger join says (main.js, readSessionFiles): the Files panel's older log of "paths this session wrote" has no times,
    // so a file another agent wrote later would still be counted.
    return this.sessionSet ?? new Set();
  },

  setView(view, cx) {
    this.view = view;
    localStorage.setItem("view", view);
    cx.notify();
  },

  toggleGroup(scope, cx) {
    if (!this.collapsed.delete(scope)) this.collapsed.add(scope);
    localStorage.setItem("collapsed", JSON.stringify([...this.collapsed]));
    cx.notify();
  },

  setDiffLayout(style, cx) {
    this.diffLayout = style;
    localStorage.setItem("diff-layout", style);
    setShared("better-changes.diff-layout", style);
    cx.notify();
  },

  // ── Sidebar ───────────────────────────────────────────────────────────────

  render() {
    if (this.mode === "panel-key") return div();
    if (this.mode === "pane-header") return this.renderPaneHeader();
    if (this.mode === "diff") return this.renderDiff();
    // VNH: a vertical rail on the left switches the section (Changes, Commits, PRs, Stashes); the header names it and holds its actions.
    return Panel({ id: "better-changes" }).child(
      h_flex().flex_1().min_h(0)
        .child(this.renderRail())
        .child(
          v_flex().flex_1().h_full().min_w(0).min_h(0)
            .child(this.renderHeader())
            .child(
              this.tab === "commit"
                ? this.selectedCommit
                  ? this.renderCommit()
                  : this.renderHistory()
                : this.tab === "pr"
                  ? this.renderPulls()
                  : this.tab === "stash"
                    ? this.renderStashes()
                    : this.renderChanges(),
            ),
        ),
    );
  },

  // VNH: the rail. Counts: what is changed, what is not pushed, the open pull requests, the stashes.
  renderRail() {
    const t = theme();
    const unpushed = this.committed?.unpushed?.size || 0, stashes = this.stashes?.length || 0;
    const files = this.sessionOnly && this.sessionSet ? this.sessionSet.size : this.total || 0;
    const items = [
      { id: "changes", icon: "diff", label: this.sessionOnly ? "Changes · this session's files" : "Changes", count: files, tone: "accent" },
      { id: "commit", icon: "commit", label: unpushed ? `Commits · ${unpushed} not pushed` : "Commits", count: unpushed, tone: "accent" },
      ...(this.forge?.() || this.tab === "pr" ? [{ id: "pr", icon: "pr-open", label: "Pull requests", count: this.prs?.length || 0, tone: "dim" }] : []),
      ...(stashes || this.tab === "stash" ? [{ id: "stash", icon: "archive", label: `Stashes · ${stashes}`, count: stashes, tone: "dim" }] : []),
    ];
    return v_flex().id("rail").w(44).h_full().flex_none().items_center().gap(4).py(8).border_r(1).border_color(t.border).role("tab_list")
      .children(items.map((i) => RailButton({ id: `rail-${i.id}`, icon: i.icon, label: i.label, count: i.count, tone: i.tone, active: this.tab === i.id, onClick: (cx) => this.setTab(i.id, cx) })));
  },

  renderHeader() {
    const t = theme();
    const title = { changes: "Changes", commit: "Commits", pr: "Pull requests", stash: "Stashes" }[this.tab] ?? "Changes";
    const forge = this.forge?.();
    const sub = this.tab === "changes" || this.tab === "commit" ? this.branch : this.tab === "pr" ? forge?.repo ?? forge?.project : null;
    return PanelHeader()
      .px(12)
      .child(
        h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().flex_none().font_semibold().text_size(TEXT.menu).text_color(t.foreground).child(title))
          .when(Boolean(sub), (el) => el.child(div().min_w(0).truncate().text_size(TEXT.small).text_color(t.dim).child(String(sub)))),
      )
      // VNH: a toggle between the flat list and the tree (its icon is the current view's); the rest of the view options
      // (columns, diff layout, staging) are in the ⋮ menu.
      .when(this.tab === "changes", (el) => el.child(
        IconButton({
          id: "session-toggle",
          icon: "filter",
          label: this.sessionOnly ? "Only this session's files: show every file" : "Show only this session's files",
          active: this.sessionOnly,
          onClick: (cx) => this.setSessionOnly(!this.sessionOnly, cx),
        }),
      ))
      .when(this.tab === "changes", (el) => el.child(
        IconButton({
          id: "view-toggle",
          icon: (VIEWS.find((v) => v.id === this.view) ?? VIEWS[0]).icon,
          label: this.view === "tree" ? "Tree view: switch to the flat list" : "Flat list: switch to the tree view",
          onClick: (cx) => this.setView(this.view === "tree" ? "flat" : "tree", cx),
        }),
      ))
      .child(
        IconButton({
          id: "refresh",
          icon: "refresh",
          label: "Refresh",
          spinning: this.refreshSpinning,
          onClick: (cx) => this.refreshAll(cx),
        }),
      )
      .child(this.renderMore());
  },

  refreshAll(cx) {
    this.refresh(cx);
    if (this.tab === "commit") this.loadCommits(cx);
    if (this.tab === "pr") this.loadPulls(cx, true);
    if (this.refreshSpinning) return;
    this.refreshSpinning = true;
    cx.notify();
    cx.timer.after(SPIN_MS, (cx) => this.stopSpinningWhenRead(cx));
  },

  // Git usually answers at once, so the icon always makes a full turn to be seen.
  stopSpinningWhenRead(cx) {
    if (this.loading || this.commitsLoading || this.prsLoading) {
      cx.timer.after(SPIN_MS, (cx) => this.stopSpinningWhenRead(cx));
      return;
    }
    this.refreshSpinning = false;
    cx.notify();
  },

  // VNH: Fork style: a check column on the left, the option's icon, its label: the options of the ⋮ menu (file list view,
  // diff layout, staging). `close` shuts the menu after a choice.
  viewOptions(close) {
    const t = theme();
    const option = (id, icon, label, selected, set) =>
      h_flex().id(`vm-${id}`).h(28).flex_none().px(6).gap(8).items_center().rounded(6).cursor_pointer()
        .text_size(12.5).text_color(t.foreground)
        .role("menu_item_radio").aria_selected(Boolean(selected))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { close(); set(cx); cx.notify(); })
        .child(div().w(14).flex_none().flex().justify_center()
          .when(selected, (el) => el.child(Icon("check", 13).text_color(t.foreground))))
        .child(Icon(icon, 14).text_color(t.muted))
        .child(div().flex_1().child(label));
    return [
      option("flat", "flat", "Flat list (single column)", this.view === "flat", (cx) => this.setView("flat", cx)),
      option("columns", "columns", "Flat list (multiple columns)", this.view === "columns", (cx) => this.setView("columns", cx)),
      option("tree", "tree", "Tree view", this.view === "tree", (cx) => this.setView("tree", cx)),
      MenuDivider(),
      option("inline", "diff-inline", "Inline diff", this.diffLayout === "inline", (cx) => this.setDiffLayout("inline", cx)),
      option("split", "diff-split", "Side by side diff", this.diffLayout === "split", (cx) => this.setDiffLayout("split", cx)),
      MenuDivider(),
      option("fluid-staging", "staging-fluid", "Fluid staging", this.staging !== "split", (cx) => this.setStaging("fluid", cx)),
      option("split-staging", "staging-split", "Split view staging", this.staging === "split", (cx) => this.setStaging("split", cx)),
    ];
  },

  // VNH: Fetch / Pull / Push, with what is waiting each way.
  syncOptions(close) {
    const t = theme(), ahead = this.committed?.unpushed?.size ?? 0, behind = Number(this.behind) || 0;
    const busy = Boolean(this.syncing) || this.busy;
    const row = (id, icon, label, count) =>
      h_flex().id(`sync-${id}`).h(28).flex_none().px(6).gap(8).items_center().rounded(6).text_size(12.5)
        .text_color(busy ? t.dim : t.foreground).opacity(busy ? 0.5 : 1)
        .when(!busy, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { close(); this.syncAction(id, cx); cx.notify(); }))
        .child(div().w(14).flex_none())
        .child(Icon(icon, 14).text_color(t.muted))
        .child(div().flex_1().child(this.syncing === id ? `${label}…` : label))
        .when(count > 0, (el) => el.child(div().text_size(TEXT.caption).text_color(t.dim).child(String(count))));
    return [
      row("fetch", "refresh", "Fetch", 0),
      row("pull", "chevron-down", "Pull (fast-forward)", behind),
      row("push", "external-link", "Push", ahead),
      MenuDivider(),
      h_flex().id("sync-stash").h(28).flex_none().px(6).gap(8).items_center().rounded(6).text_size(12.5)
        .text_color(busy ? t.dim : t.foreground).opacity(busy ? 0.5 : 1)
        .when(!busy, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { close(); this.stashAll(cx); cx.notify(); }))
        .child(div().w(14).flex_none())
        .child(Icon("minus", 14).text_color(t.muted))
        .child(div().flex_1().child(this.syncing === "stash" ? "Stashing…" : "Stash all changes")),
    ];
  },

  renderMore() {
    return Menu({
      id: "more",
      open: this.menuOpen,
      focus: this.menuFocus,
      onOpenChange: (open, cx) => {
        this.menuOpen = open;
        cx.notify();
      },
      trigger: IconButton({ id: "more-trigger", icon: "more", label: "Options" }),
      width: 250,
      children: [...this.viewOptions(() => { this.menuOpen = false; }), MenuDivider(), ...this.syncOptions(() => { this.menuOpen = false; })],
    });
  },

  renderChanges() {
    const list = v_flex().id("changes-list").flex_1().min_h(0).overflow_y_scrollbar().p(6);
    if (this.error) return list.child(Message(this.error, true));
    const mine = this.sessionPaths(), keep = (arr) => (mine ? arr.filter((f) => mine.has(f.path)) : arr);
    const files = keep(this.files);
    const conflicts = files.filter((f) => f.conflict);
    const unstaged = files.filter((f) => f.unstaged && !f.conflict);
    const staged = files.filter((f) => f.staged);
    // Filtered by a session, the list is about what is still uncommitted: the Committed group (what the branch has over its remote) is left out.
    const committed = mine ? null : this.committed?.total ? this.committed : null;
    if (mine) list.child(this.sessionChip(files.length, files.map((f) => f.path)));
    else if (this.sessionOnly) list.child(div().px(8).h(22).flex().items_center().text_size(TEXT.caption).text_color(theme().dim).child("Only this session's files: no agent in view, showing every file"));
    const nothing = !conflicts.length && !unstaged.length && !staged.length && !committed;
    // VNH: split view staging, as Fork's: working changes above, the staging area below.
    if (this.staging === "split" && !nothing) return this.renderSplitStaging(list, conflicts, unstaged, staged, committed);
    if (nothing)
      // No "Loading changes…" line: only what the list says (it is empty until the repository is read, then it is right).
      list.child(Message(mine ? "None of this session's files has changes" : "No changes"));
    this.groupsDrawn = 0;
    this.addGroup(list, "conflict", "Conflicts", conflicts);
    this.addGroup(list, "staged", "Staged", staged);
    this.addGroup(list, "unstaged", "Unstaged", unstaged);
    if (committed)
      this.addGroup(
        list,
        "committed",
        "Committed",
        committed.files,
        `not on ${committed.name}`,
        committed.total,
      );
    const limit = this.settings.limits.files;
    if (this.total > limit)
      list.child(Message(`Showing the first ${limit.toLocaleString()} changed files.`));
    return v_flex().id("changes").flex_1().min_h(0).child(list).child(this.renderCommitBox());
  },

  // VNH: tells the agent in view to commit the files it wrote (the list is in the message).
  async askAgentCommit(paths, cx) {
    const terminal = (this.mineTerms ?? [])[0];
    if (!terminal || !paths.length || this.askingAgent) return;
    this.askingAgent = true;
    const shown = paths.slice(0, 200), more = paths.length - shown.length;
    const text = [
      "Hãy commit các file bạn vừa sửa trong session này. Chỉ đúng những file sau (đường dẫn tính từ gốc repo " + this.root + "), đừng đụng file nào khác và đừng dùng git add -A hay git add .:",
      ...shown.map((p) => `- ${p}`),
      ...(more > 0 ? [`- … và ${more} file nữa (xem git status)`] : []),
      "Stage đúng các file này bằng git add -- <file>, viết commit message theo Conventional Commits mô tả đúng thay đổi (nếu chúng thuộc các nhóm khác nhau thì chia thành nhiều commit), không push. Nếu có file trong danh sách mà thực ra không phải bạn sửa thì bỏ qua và nói cho tôi biết.",
    ].join("\n");
    try {
      const r = await exec("sh", ["-c", 'exec "$HOME/.local/bin/hc" send "$@"', "hc", terminal, text], { timeout: 20000 });
      if (r.code !== 0) notify({ title: "Couldn't reach the agent", body: String(r.stderr || r.stdout).trim().split("\n")[0].slice(0, 160), level: "error", timeout: 6000 });
      else notify({ title: "Asked the agent to commit", body: `${paths.length} file${paths.length === 1 ? "" : "s"}`, level: "success", timeout: 3000 });
    } catch (e) {
      notify({ title: "Couldn't reach the agent", body: String(e?.message ?? e).slice(0, 160), level: "error", timeout: 6000 });
    } finally {
      this.askingAgent = false;
    }
  },

  // VNH: says the list is filtered, and turns it off with a click.
  sessionChip(shown, paths) {
    const t = theme(), total = this.files.length;
    // One click tells the agent to commit exactly these files (hc send: pasted into its terminal and submitted).
    const askable = paths.length > 0 && (this.mineTerms ?? []).length === 1 && !this.on;
    return h_flex().id("session-chip").flex_none().h(26).px(8).mb(4).gap(6).items_center().rounded(6).cursor_pointer()
      .bg(t.hover).text_size(TEXT.caption).text_color(t.muted).tooltip("Show every changed file")
      .on_click((_e, cx) => this.setSessionOnly(false, cx))
      .child(Icon("check", 12).text_color(t.accent))
      .child(div().flex_1().min_w(0).truncate().child(`Only this session's files · ${shown} of ${total}`))
      .when(askable, (el) => el.child(TextButton({ id: "session-commit", icon: "commit", label: "Ask agent to commit", onClick: (cx) => this.askAgentCommit(paths, cx) })))
      .child(Icon("close", 12).text_color(t.dim));
  },

  renderSplitStaging(top, conflicts, unstaged, staged, committed) {
    const t = theme();
    this.groupsDrawn = 0;
    this.addGroup(top, "conflict", "Conflicts", conflicts);
    this.addGroup(top, "unstaged", "Unstaged", unstaged);
    if (committed)
      this.addGroup(top, "committed", "Committed", committed.files, `not on ${committed.name}`, committed.total);
    if (!this.groupsDrawn) top.child(Message("No unstaged changes"));
    const limit = this.settings.limits.files;
    if (this.total > limit) top.child(Message(`Showing the first ${limit.toLocaleString()} changed files.`));
    const bottom = v_flex().id("staged-list").size_full().min_h(0).overflow_y_scrollbar().p(6);
    this.groupsDrawn = 0;
    this.addGroup(bottom, "staged", "Staged", staged);
    if (!this.groupsDrawn) bottom.child(Message("Nothing staged · press + on a file to stage it"));
    // A draggable divider between the two (the group keeps the drag in the window); the
    // top's height is saved so it comes back after a restart.
    let saved = null;
    try { saved = Number(localStorage.getItem("vnh-staging-top")) || null; } catch {}
    const split = v_resizable("vnh-split-staging").flex_1().min_h(0).w_full()
      .on_resize((sizes) => { try { if (sizes?.[0] > 0) localStorage.setItem("vnh-staging-top", String(Math.round(sizes[0]))); } catch {} })
      .child(resizable_panel().when(Boolean(saved), (el) => el.size(saved)).size_range(70).child(this.dropZone("unstaged", top.size_full())))
      .child(resizable_panel().size_range(70).child(v_flex().size_full().border_t(1).border_color(t.border).child(this.dropZone("staged", bottom))));
    return this.dragSurface(v_flex().id("changes").flex_1().min_h(0).child(split).child(this.renderCommitBox()));
  },

  // VNH: drag a file between the two areas to stage or unstage it. A press on a row records
  // dragStart; moving 5px makes it a drag; releasing over the other area runs the index action.
  // Only the index changes (git add / git reset), never the files on disk.
  dropTarget(scope) {
    const d = this.dragging;
    if (!d) return false;
    return scope === "staged" ? d.scope === "unstaged" : d.scope === "staged";
  },

  dropZone(scope, el) {
    const t = theme();
    const hot = this.dropTarget(scope) && this.dropOver === scope;
    return v_flex().id(`drop-${scope}`).size_full().min_h(0).relative()
      .on_mouse_move((_e, cx) => { if (this.dragging && this.dropOver !== scope) { this.dropOver = scope; cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => {
        const d = this.dragging;
        if (d && this.dropTarget(scope)) this.indexAction(scope === "staged" ? "stage" : "unstage", d.path, cx);
      })
      .child(el)
      .when(hot, (z) => z.child(div().absolute().inset_0().rounded(8).border_2().border_color(t.accent).bg(t.accent + "14")));
  },

  dragSurface(el) {
    const t = theme(), d = this.dragging;
    return el.relative()
      .on_mouse_move((e, cx) => {
        const s = this.dragStart;
        if (s && !this.dragging && Math.hypot(e.position.x - s.x, e.position.y - s.y) > 5) this.dragging = s;
        if (this.dragging) { this.dragAt = e.local_position; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const was = this.dragging;
        this.dragStart = null; this.dragging = null; this.dropOver = null;
        if (was) cx.notify();
      })
      .on_hover((hovered, cx) => { if (!hovered && (this.dragStart || this.dragging)) { this.dragStart = null; this.dragging = null; this.dropOver = null; cx.notify(); } })
      .when(Boolean(d && this.dragAt), (z) => z.child(
        h_flex().absolute().left(this.dragAt.x + 12).top(this.dragAt.y + 6).h(24).px(8).gap(6).items_center().rounded(6)
          .bg(t.popover).border_1().border_color(t.border).text_size(TEXT.small).text_color(t.foreground)
          .child(Icon(d.scope === "unstaged" ? "plus" : "minus", 12).text_color(d.scope === "unstaged" ? t.ansi2 : t.ansi1))
          .child(div().max_w(180).truncate().child(d.name))));
  },

  renderCommitBox() {
    const t = theme();
    const hint = this.commitBoxHint();
    return v_flex()
      .id("commit-box")
      .flex_none()
      .p(10)
      .gap(8)
      .border_t(1)
      .border_color(t.border)
      .when(Boolean(this.note), (el) =>
        el.child(
          div()
            .text_size(TEXT.small)
            .text_color(t.ansi1)
            .whitespace_normal()
            .child(this.note ?? ""),
        ),
      )
      .child(
        TextBox({
          id: "commit-message",
          state: this.input,
          focused: this.typing,
          label: "Commit message",
          height: null, // VNH: auto-grow (main.js)
        }),
      )
      .child(this.renderCommitButton())
      .when(Boolean(hint), (el) =>
        el.child(
          div()
            .text_size(TEXT.caption)
            .text_color(this.commitMode === "amend" ? t.working : t.dim)
            .whitespace_normal()
            .child(hint ?? ""),
        ),
      );
  },

  commitBoxHint() {
    if (this.amendLoading) return "Loading the latest commit…";
    if (this.conflicts) return "Resolve conflicts and stage the files before committing.";
    if (this.commitMode === "amend") {
      return "Amend rewrites the latest commit. Unstaged changes stay untouched.";
    }
    return null;
  },

  commitButtonLabel() {
    if (this.operation === "commit") return "Committing…";
    if (this.operation === "amend") return "Amending…";
    if (this.operation === "push") return "Pushing…";
    return this.commitMode === "amend" ? "Amend" : this.commitMode === "push" ? "Commit and Push" : "Commit";
  },

  // VNH: ✨ before Commit writes a Conventional Commits message for the staged diff with the
  // agent CLI running in this space (Claude Code: `claude -p --model haiku`; Codex: `codex exec`).
  // It only fills the message box; nothing is committed until you press Commit.
  generateMessage(cx) {
    if (this.generating) return;
    if (!this.files.some((f) => f.staged)) {
      notify({ title: "Nothing staged", body: "Stage the files to describe first.", level: "warning", timeout: 3000 });
      return;
    }
    const space = spaces().find((s) => s.active)?.id;
    const mine = agents().filter((a) => a.space === space).sort((a, b) => (b.focused - a.focused) || (b.seq - a.seq));
    const kind = (mine[0]?.app ?? "claude-code") === "codex" ? "codex" : "claude";
    this.generating = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", GENERATE_SCRIPT, "generate", kind, COMMIT_PROMPT], { cwd: this.root, on: this.on ?? null, timeout: 120000 });
        if (r.code === 3) throw new Error("Nothing staged.");
        if (r.code !== 0) throw new Error((r.stderr || "").trim().split("\n").pop() || `${kind} exited ${r.code}`);
        const text = cleanMessage(r.stdout);
        if (!text) throw new Error(`${kind} returned no message.`);
        this.message = text;
        this.input.set_value(text);
      } catch (e) {
        notify({ title: "Couldn't write a commit message", body: String(e?.message ?? e), level: "error", timeout: 5000 });
      } finally {
        this.generating = false;
        cx.notify();
      }
    });
  },

  renderCommitButton() {
    return this.renderCommitSplit();
  },

  // A square button as tall as Commit, on the same raised background.
  renderGenerateButton() {
    const t = theme();
    const ready = !this.generating && !this.busy && this.files.some((f) => f.staged);
    const label = this.generating ? "Writing the commit message…" : ready
      ? "Write the commit message with AI (Conventional Commits) · ⌥S" : "Stage files to write a commit message with AI";
    const icon = Icon("sparkles", 15);
    return div().id("generate-message").w(34).h_full().flex_none().flex().items_center().justify_center()
      .rounded_l(8).bg(t.raised).text_color(ready || this.generating ? t.foreground : t.dim)
      .accessibility_label(label).tooltip(label)
      .when(ready, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); this.generateMessage(cx); }))
      .child(this.generating ? icon.spin(SPIN_MS) : icon);
  },

  renderCommitSplit() {
    const amend = this.commitMode === "amend";
    return SplitButton({
      id: "commit",
      icon: amend ? "amend" : "commit",
      label: this.commitButtonLabel(),
      enabled: this.canCommit(),
      primary: !amend,
      onClick: (cx) => this.commit(cx),
      menu: this.renderCommitMenu(),
      lead: this.renderGenerateButton(), // VNH: ✨ joined to Commit, as the ▾ is
    });
  },

  renderCommitMenu() {
    const amend = this.commitMode === "amend";
    const choose = (mode) => (cx) => this.setCommitMode(mode, cx);
    const options = [
      MenuOption({
        id: "mode-commit",
        icon: "commit",
        label: "Commit",
        selected: this.commitMode !== "amend" && this.commitMode !== "push",
        onClick: choose("commit"),
      }),
      MenuOption({
        id: "mode-push",
        icon: "commit",
        label: "Commit and Push",
        selected: this.commitMode === "push",
        onClick: choose("push"),
      }),
    ];
    if (this.hasHead) {
      options.push(
        MenuOption({
          id: "mode-amend",
          icon: "amend",
          label: "Amend",
          selected: amend,
          onClick: choose("amend"),
        }),
      );
    }
    return Menu({
      id: "commit-menu",
      open: this.commitMenuOpen,
      focus: this.commitMenuFocus,
      anchor: "bottom_right",
      onOpenChange: (open, cx) => {
        this.commitMenuOpen = open;
        cx.notify();
      },
      trigger: SplitTrigger({ id: "commit-options", label: "Commit options" }),
      children: options,
    });
  },

  addGroup(list, scope, label, files, detail, count = files.length) {
    if (!files.length) return;
    const collapsed = this.collapsed.has(scope);
    const bulk = {
      unstaged: { action: "stage", icon: "plus", label: "Stage all" },
      staged: { action: "unstage", icon: "minus", label: "Unstage all" },
    }[scope];
    list.child(
      GroupHeader({
        id: `group-${scope}`,
        label,
        count,
        detail,
        danger: scope === "conflict",
        collapsed,
        divided: this.groupsDrawn++ > 0,
        action:
          bulk &&
          TextButton({
            id: `${bulk.action}-all`,
            icon: bulk.icon,
            label: bulk.label,
            onClick: (cx) => this.indexAction(bulk.action, null, cx),
          }),
        onClick: (cx) => this.toggleGroup(scope, cx),
      }),
    );
    if (collapsed) return;
    if (this.view === "columns") list.child(this.columnsHeader());
    // VNH: a group draws its first ROW_CAP files; the rest come on a click. A repo with hundreds of changed files made one
    // render so long that Herdr interrupted it ("This view could not be re-rendered … interrupted") and the panel stayed on
    // its last good frame.
    this.rowCap ??= {};
    (this.groupFiles ??= {})[scope] = files;
    const cap = this.rowCap[scope] ?? ROW_CAP;
    this.addRows(list, scope, files.length > cap ? files.slice(0, cap) : files);
    if (files.length > cap) {
      const t = theme(), more = files.length - cap;
      list.child(
        h_flex().id(`more-${scope}`).h(28).flex_none().px(8).items_center().rounded(6).cursor_pointer()
          .text_size(12).text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.rowCap[scope] = cap + ROW_MORE; cx.notify(); })
          .child(`Show ${Math.min(ROW_MORE, more)} more · ${more.toLocaleString()} not shown`),
      );
    }
  },

  // A group's files, flat or nested as chosen in the options menu.
  // VNH: the column titles over a group's rows in the multiple columns view.
  columnsHeader() {
    const t = theme();
    return h_flex().h(20).flex_none().pl(8 + 14 + 6).pr(8).gap(6).items_center()
      .text_size(TEXT.caption).text_color(t.dim)
      .child(div().w("42%").flex_none().child("Name"))
      .child(div().flex_1().min_w(0).child("Folder"))
      .child(div().w(70).flex_none().text_right().child("Changes"))
      .child(div().w(12).flex_none())
      .child(div().w(18).flex_none());
  },

  addRows(list, scope, files) {
    if (this.view === "flat" || this.view === "columns") {
      for (const file of files) list.child(this.fileRow(file, scope, 0));
      return;
    }
    const closed = new Set(
      [...this.closed]
        .filter((key) => key.startsWith(`${scope}:`))
        .map((key) => key.slice(scope.length + 1)),
    );
    for (const row of fileTree(files, closed))
      list.child(
        row.kind === "folder"
          ? this.folderRow(row, scope, closed.has(row.path))
          : this.fileRow(row.file, scope, row.depth),
      );
  },

  folderRow(row, scope, closed) {
    const t = theme();
    const key = `${scope}:${row.path}`;
    return Row({
      id: `folder-${key}`,
      depth: row.depth,
      stem: !closed,
      onClick: (cx) => {
        if (closed) this.closed.delete(key);
        else this.closed.add(key);
        cx.notify();
      },
    })
      .child(Chevron(!closed))
      .when(Boolean(this.fileIcons), (el) =>
        el.child(FileIcon({ icons: this.fileIcons, path: `${this.root}/${row.path}`, dir: true, open: !closed, t })),
      )
      .child(div().flex_1().min_w(0).truncate().child(row.name))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        const under = (this.groupFiles?.[scope] ?? []).filter((f) => f.path.startsWith(`${row.path}/`));
        this.openMenu(scope, "folder", row.name, row.path, under);
      });
  },

  // The status letter of a file as the group `scope` lists it.
  statusIn(file, scope) {
    return scope === "staged" ? file.stagedStatus : scope === "unstaged" ? file.unstagedStatus : file.status;
  },

  // VNH: the right-click menu (vnh-changes-menu) of one file or of a folder (every file the group lists under it).
  openMenu(scope, kind, name, dir, files) {
    const statuses = {};
    for (const f of files) statuses[f.path] = this.statusIn(f, scope);
    const n = files.length, working = !["committed", "commit", "pr"].includes(scope);
    openOverlay({
      mod: "vnh-changes-menu", kind: "popup", width: 250, height: working ? 500 : 250,
      props: { root: this.root, on: this.on ?? null, kind, name, dir, scope, paths: files.map((f) => f.path), statuses },
    });
  },

  fileRow(file, scope, depth) {
    const t = theme();
    const parts = file.path.split("/");
    const name = parts.pop();
    const tree = this.view === "tree";
    const stats =
      scope === "staged" ? file.stagedStats : scope === "unstaged" ? file.unstagedStats : file;
    const status =
      scope === "staged"
        ? file.stagedStatus
        : scope === "unstaged"
          ? file.unstagedStatus
          : file.status;
    const open = shared("better-changes.selection");
    const row = Row({
      id: `file-${scope}-${file.path}`,
      depth,
      selected: open?.path === file.path && open?.scope === scope,
      onClick: (cx) => this.pick(file, scope, cx),
    }).child(FileIcon({ icons: this.fileIcons, path: `${this.root}/${file.path}`, color: t.muted, t }));
    const columns = this.view === "columns";
    // VNH: a right-click opens the file's menu (vnh-changes-menu: Rollback…, Delete…, Stage, Unstage).
    row.on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(scope, "file", name, null, [file]); });
    // VNH: start a drag (see dropZone); a plain click still opens the diff.
    if (this.staging === "split" && (scope === "staged" || scope === "unstaged")) row.on_mouse_down("left", (e) => { this.dragStart = { path: file.path, scope, name, x: e.position.x, y: e.position.y }; });
    if (tree) row.child(div().flex_1().min_w(0).truncate().child(name));
    else if (columns)
      row.child(div().w("42%").flex_none().min_w(0).truncate().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.small).text_color(t.dim).child(parts.join("/") || "."));
    else
      row.child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(6)
          .items_center()
          .child(div().max_w(190).flex_none().truncate().child(name))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(TEXT.small)
              .text_color(t.dim)
              .child(parts.join("/")),
          ),
      );
    if (file.conflict)
      row.child(
        div().flex_none().text_size(TEXT.caption).text_color(t.ansi1).child(file.conflictKind),
      );
    else if (columns) row.child(h_flex().w(70).flex_none().justify_end().child(DiffStat(stats))).child(StatusLetter(status));
    else row.child(DiffStat(stats)).child(StatusLetter(status));
    // VNH: a checkbox in place of + / −: ticked means staged; a click stages or unstages.
    if (scope === "unstaged" || scope === "staged") row.child(this.stageBox(file.path, scope === "staged"));
    return row;
  },

  stageBox(path, checked) {
    const t = theme();
    return div().id(`${checked ? "unstage" : "stage"}-${path}`).size(18).flex_none().flex().items_center().justify_center()
      .cursor_pointer().role("check_box").aria_selected(checked)
      .accessibility_label(checked ? "Unstage" : "Stage").tooltip(checked ? "Unstage" : "Stage")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // not a drag start
      .on_click((_e, cx) => { cx.stop_propagation(); this.indexAction(checked ? "unstage" : "stage", path, cx); })
      .child(div().size(14).flex_none().flex().items_center().justify_center().rounded(3).border_1()
        .border_color(checked ? t.accent : t.dim).when(checked, (el) => el.bg(t.accent))
        .hover((st) => st.border_color(t.accent))
        .when(checked, (el) => el.child(Icon("check", 11).text_color(t.background))));
  },

  // VNH: the stashes: a click or a right-click opens the stash's menu (Apply, Pop, Drop, Copy).
  renderStashes() {
    const t = theme();
    const list = v_flex().id("stash-list").flex_1().min_h(0).overflow_y_scrollbar().p(6);
    if (!this.stashes?.length) return list.child(Message("No stashes"));
    for (const [i, s] of this.stashes.entries()) {
      const open = (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "vnh-changes-menu", kind: "popup", width: 250, height: 170, props: { kind: "stash", root: this.root, on: this.on ?? null, ref: s.ref, message: s.message || s.full } });
      };
      list.child(
        h_flex().id(`stash-${i}`).flex_none().px(8).py(6).gap(8).items_center().rounded(7).cursor_pointer()
          .hover((x) => x.bg(t.hover)).on_click(open).on_mouse_down("right", open)
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().truncate().child(s.message || s.full))
            .child(div().truncate().text_size(TEXT.caption).text_color(t.dim).child(`${s.ref} · ${timeAgo(s.at)}`))),
      );
    }
    return list;
  },

  renderHistory() {
    const list = v_flex().id("commit-list").flex_1().min_h(0).overflow_y_scrollbar().p(6);
    if (this.commitsError) return list.child(Message(this.commitsError, true));
    if (!this.commits.length)
      return list.child(
        Message(this.commitsLoading || !this.root ? "Loading history…" : "No commits yet"),
      );
    this.groupsDrawn = 0;
    const remote = this.committed;
    const more = this.commitsDone ? "" : "+";
    const local = this.branch ?? "HEAD";
    if (!remote) {
      this.addCommits(list, {
        scope: "branch",
        label: local,
        count: `${this.commits.length}${more}`,
        commits: this.commits,
        withMore: true,
      });
      return list;
    }
    const notPulled = (n) => (n ? `${n} not pulled` : null);
    const detail = (...parts) => parts.filter(Boolean).join(" · ");
    const head = this.remoteHead;
    const pushed = this.commits.filter((c) => !remote.unpushed.has(c.hash));
    this.addCommits(list, {
      scope: "branch",
      label: local,
      count: remote.unpushed.size,
      commits: this.commits.filter((c) => remote.unpushed.has(c.hash)),
    });
    if (head && head.target !== remote.name) {
      // A feature branch: what the remote branch has, then the default branch under it.
      const onBranch = pushed.filter((c) => head.ahead.has(c.hash));
      const onDefault = pushed.filter((c) => !head.ahead.has(c.hash));
      this.addCommits(list, {
        scope: "remote",
        label: remote.name,
        count: onBranch.length,
        commits: onBranch,
        detail: notPulled(this.behind),
      });
      this.addCommits(list, {
        scope: "default",
        label: head.name,
        count: `${onDefault.length}${more}`,
        commits: onDefault,
        detail: detail(head.target, notPulled(head.behind)),
        withMore: true,
      });
      return list;
    }
    this.addCommits(list, {
      scope: "remote",
      label: remote.name,
      count: `${pushed.length}${more}`,
      commits: pushed,
      detail: detail(head?.name, notPulled(this.behind)),
      withMore: true,
    });
    return list;
  },

  addCommits(list, { scope, label, count, commits, detail, withMore = false }) {
    if (!commits.length) return;
    const t = theme();
    const collapsed = this.collapsed.has(scope);
    list.child(
      GroupHeader({
        id: `group-${scope}`,
        label,
        count,
        detail,
        collapsed,
        divided: this.groupsDrawn++ > 0,
        onClick: (cx) => this.toggleGroup(scope, cx),
      }),
    );
    if (collapsed) return;
    for (const commit of commits) list.child(this.commitRow(commit));
    if (withMore && !this.commitsDone)
      list.child(
        Row({ id: "commits-more", onClick: (cx) => this.loadCommits(cx, true) })
          .justify_center()
          .text_size(TEXT.small)
          .text_color(t.muted)
          .child(this.commitsLoading ? "Loading…" : "Load more"),
      );
  },

  commitRow(commit) {
    const t = theme();
    return h_flex()
      .id(`commit-${commit.hash}`)
      .flex_none()
      .px(8)
      .py(6)
      .gap(8)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openCommit(commit, cx))
      // VNH: a right-click opens the commit's menu (vnh-changes-menu).
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({
          mod: "vnh-changes-menu", kind: "popup", width: 280, height: 470,
          props: { kind: "commit", root: this.root, on: this.on ?? null, hash: commit.hash, short: commit.short, subject: commit.subject,
            isHead: this.commits[0]?.hash === commit.hash, pushed: Boolean(this.committed?.unpushed) && !this.committed.unpushed.has(commit.hash), hasParent: this.commits.length > 1 },
        });
      })
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(1)
          .child(div().truncate().child(commit.subject))
          .child(
            div()
              .truncate()
              .text_size(TEXT.caption)
              .text_color(t.dim)
              .child(`${commit.author} · ${timeAgo(commit.at)}`),
          ),
      )
      .child(
        div()
          .flex_none()
          .text_size(TEXT.caption)
          .text_color(t.dim)
          .font_family(codeFont())
          .child(commit.short),
      );
  },

  renderCommit() {
    return v_flex()
      .id("commit-detail")
      .flex_1()
      .min_h(0)
      .child(this.renderCommitTopRow())
      .child(
        v_flex()
          .id("commit-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .child(this.renderCommitAbout())
          .child(this.renderCommitChanges()),
      );
  },

  // Only a commit the remote has can be opened there.
  commitUrl(commit) {
    if (!this.repo || this.committed?.unpushed.has(commit.hash)) return null;
    return `https://github.com/${this.repo}/commit/${commit.hash}`;
  },

  renderCommitTopRow() {
    const t = theme();
    const commit = this.selectedCommit;
    const url = this.commitUrl(commit);
    const row = PanelHeader()
      .px(8)
      .gap(4)
      .child(
        IconButton({
          id: "commit-back",
          icon: "chevron-left",
          label: "Back to commits",
          onClick: (cx) => {
            this.selectedCommit = null;
            this.pendingCommit = null;
            this.commitToken++;
            this.saveUi();
            cx.notify();
          },
        }),
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(TEXT.small)
          .text_color(t.dim)
          .font_family(codeFont())
          .child(commit.short),
      );
    if (url) {
      row.child(
        IconButton({
          id: "commit-open",
          icon: "external-link",
          label: "Open on GitHub",
          onClick: (cx) => cx.open_url(url),
        }),
      );
    }
    return row;
  },

  renderCommitAbout() {
    const t = theme();
    const commit = this.selectedCommit;
    const when = new Date(commit.at * 1000).toLocaleString();
    const about = v_flex()
      .id("commit-about")
      .flex_none()
      .px(14)
      .py(10)
      .gap(4)
      .border_b(1)
      .border_color(t.border)
      .child(div().font_medium().whitespace_normal().child(commit.subject))
      .child(
        div()
          .text_size(TEXT.caption)
          .text_color(t.dim)
          .whitespace_normal()
          .child(`${commit.author} · ${when}`),
      );
    if (commit.body) {
      about.child(
        div()
          .pt(6)
          .text_size(TEXT.small)
          .text_color(t.muted)
          .whitespace_normal()
          .child(commit.body),
      );
    }
    return about;
  },

  renderCommitChanges() {
    const changes = v_flex().id("commit-changes").flex_none().p(6);
    if (this.commitFilesError) return changes.child(Message(this.commitFilesError, true));
    if (this.commitFilesLoading) return changes.child(Message("Loading changes…"));
    if (this.commitFiles.length) {
      changes.child(
        GroupHeader({ id: "group-commit", label: "Changes", count: this.commitFiles.length }),
      );
    }
    this.addRows(changes, "commit", this.commitFiles);
    return changes;
  },
};

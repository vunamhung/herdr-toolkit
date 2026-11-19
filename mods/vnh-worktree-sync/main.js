import { View, div } from "gpui-kit";
import { spaces, panes, exec, run, checking } from "herdr";

// Opens every git worktree kept in a project's `.worktrees/` folder as a Herdr space.
// The shipped `spaces` sidebar nests worktree spaces under their main checkout by itself
// (it asks git for the common dir), so this mod only has to make sure the spaces exist.
//
// - Scans the repos of the spaces already open (this computer only), every 30 s.
// - Opens each worktree once, in the background (focus: false). A worktree you close stays
//   closed; one removed and created again at the same path is opened again.
// - Renders nothing: place it in a 0 px block of the layout.

const INTERVAL_MS = 30000;
const SEEN_KEY = "seen";

const under = (path, dir) => path === dir || path.startsWith(dir.endsWith("/") ? dir : dir + "/");

async function git(cwd, args) {
  const r = await exec("git", ["--no-optional-locks", ...args], { cwd, timeout: 10000 }).catch(() => null);
  return r && r.code === 0 ? r.stdout : null;
}

// The main checkout of the repo containing `cwd`, or null outside git.
async function mainCheckout(cwd) {
  const out = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const common = out?.trim();
  if (!common || !common.endsWith("/.git")) return null; // bare repos and odd layouts: skip
  return common.slice(0, -"/.git".length);
}

// Worktree paths of `top` that live in `top/.worktrees/`.
async function dotWorktrees(top) {
  const out = await git(top, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  return out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9).trim())
    .filter((p) => under(p, `${top}/.worktrees`) && p !== `${top}/.worktrees`);
}

export default class WorktreeSync extends View {
  init(_props, cx) {
    try { this.seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") || {}; } catch { this.seen = {}; }
    this.busy = false;
    if (checking()) return;
    this.sync(cx);
    cx.timer.every(INTERVAL_MS, (cx) => this.sync(cx));
  }

  sync(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async () => {
      try {
        const local = spaces().filter((s) => !s.machine);
        const localTabs = new Set(local.flatMap((s) => s.tabs.map((t) => t.id)));
        const folders = [
          ...local.map((s) => s.folder),
          ...panes().filter((p) => p.cwd && localTabs.has(p.tab)).map((p) => p.cwd),
        ].filter(Boolean);

        const tops = new Set();
        for (const f of new Set(folders)) {
          const top = await mainCheckout(f);
          if (top) tops.add(top);
        }

        const isOpen = (path) => folders.some((f) => under(f, path));
        const known = new Set();
        let changed = false;
        for (const top of tops) {
          for (const path of await dotWorktrees(top)) {
            known.add(path);
            if (isOpen(path)) {
              if (!this.seen[path]) { this.seen[path] = true; changed = true; }
              continue;
            }
            if (this.seen[path]) continue; // opened before and closed by the person: leave it
            run("space.new", { folder: path, machine: "", focus: false });
            this.seen[path] = true;
            changed = true;
          }
          // Forget worktrees of this repo that no longer exist, so a new one at the same path opens.
          for (const path of Object.keys(this.seen)) {
            if (under(path, `${top}/.worktrees`) && !known.has(path)) { delete this.seen[path]; changed = true; }
          }
        }
        if (changed) localStorage.setItem(SEEN_KEY, JSON.stringify(this.seen));
      } finally {
        this.busy = false;
      }
    });
  }

  render() {
    return div().size_0();
  }
}

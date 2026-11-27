import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "herdr" || specifier === "gpui-kit" || specifier === "gpui-base") {
      return { url: `mock:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:herdr") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          import { execFile } from "node:child_process";
          import { promisify } from "node:util";
          const runFile = promisify(execFile);
          export const exec = async (cmd, args = [], opts = {}) => {
            try {
              const { stdout, stderr } = await runFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout });
              return { code: 0, stdout, stderr };
            } catch (e) {
              return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
            }
          };
          const store = new Map();
          export const shared = (k) => store.get(k);
          export const setShared = (k, v) => store.set(k, v);
          export const home = () => process.env.HOME;
          export const window = () => ({ platform: process.platform === "darwin" ? "macos" : "linux", active: true });
          export const spaces = () => [];
          export const panes = () => [];
          export const terminals = () => [];
          export const focused = () => null;
          export const hc = async () => ({ code: 0, stdout: "", stderr: "" });
          export const run = () => {};
          export const notify = () => {};
          export const readTextFile = async () => null;
          export const checking = () => true;
        `,
      };
    }
    if (url === "mock:gpui-kit") {
      return { format: "module", shortCircuit: true, source: "export class View {} export const div = () => ({ size_0() { return this; } });" };
    }
    return nextLoad(url, context);
  },
});

const { flagsOf, isWoken, woke } = await import("../mods/vnh-agents/sleep.js");
const { parseDotWorktrees } = await import("../mods/vnh-worktree-sync/main.js");
const { parseBranch, parseStatus, parseNumstat, emptyGit, collator, relTo, listDir } = await import("../mods/vnh-filetree/git.js");

test("sleep.js flagsOf preserves launch flags and drops resume/prompt args", () => {
  assert.deepEqual(
    flagsOf("claude", ["claude", "--model", "opus", "--resume", "abc", "-c", "--effort=high", "prompt", "--", "--ignored"]),
    ["--model", "opus", "--effort=high"],
  );
  assert.deepEqual(
    flagsOf("agy", ["agy", "--conversation", "uuid-1", "--model", "gemini-2.5", "-c"]),
    ["--model", "gemini-2.5"],
  );
  assert.deepEqual(
    flagsOf("codex", ["codex", "-m", "o3", "--sandbox", "workspace-write", "fix bug"]),
    ["-m", "o3", "--sandbox", "workspace-write"],
  );
});

test("sleep.js isWoken clears wake record on non-done status", () => {
  woke.length = 0;
  woke.push({ terminal: "t1", space: "s1", at: Date.now() });
  assert.equal(isWoken({ address: "t1", space: "s1", status: "done" }, Date.now()), true);
  assert.equal(isWoken({ address: "t1", space: "s1", status: "working" }, Date.now()), false);
  // Once cleared by working, the next done must NOT be masked as woken.
  assert.equal(isWoken({ address: "t1", space: "s1", status: "done" }, Date.now()), false);
});

test("worktree-sync parseDotWorktrees handles errors, prunable stanzas, and valid worktrees", () => {
  assert.equal(parseDotWorktrees(null, "/repo"), null);
  const porcelain = [
    "worktree /repo\nHEAD aaa\nbranch refs/heads/main",
    "worktree /repo/.worktrees/live\nHEAD bbb\nbranch refs/heads/feat",
    "worktree /repo/.worktrees/gone\nHEAD ccc\nprunable gitdir file points to non-existent location",
    "worktree /other/path\nHEAD ddd\nbranch refs/heads/x",
  ].join("\n\n");
  assert.deepEqual(parseDotWorktrees(porcelain, "/repo"), ["/repo/.worktrees/live"]);
});

test("vnh-filetree git.js parsers and collator work cleanly", () => {
  assert.deepEqual(parseBranch("## main...origin/main [ahead 2, behind 1]"), {
    head: "main", upstream: "origin/main", ahead: 2, behind: 1,
  });
  assert.deepEqual(parseBranch("## HEAD (no branch)"), {
    head: "detached", upstream: "", ahead: 0, behind: 0,
  });
  const git = emptyGit();
  parseStatus("## main\0 M src/a.js\0?? src/b.js\0!! dist/\0", git);
  assert.equal(git.status.get("src/a.js"), "M");
  assert.equal(git.status.get("src"), "M");
  assert.deepEqual(git.counts.get("src"), [1, 1, 0]);
  assert.equal(git.ignored.has("dist"), true);
  parseNumstat("10\t3\tsrc/a.js\0", git);
  assert.deepEqual(git.diff.get("src/a.js"), [10, 3]);
  assert.deepEqual(git.diff.get(""), [10, 3]);
  assert.equal(collator.compare("file2.js", "file10.js") < 0, true);
  assert.equal(relTo("/a/b", "/a/b/c/d.txt"), "c/d.txt");
  assert.equal(relTo("/a/b", "/a/b2/c.txt"), null);
});

test("vnh-filetree listDir handles empty folders and special filenames", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "vnh-ft-empty-"));
  const pop = fs.mkdtempSync(path.join(os.tmpdir(), "vnh-ft-pop-"));
  try {
    const rEmpty = await listDir(empty, null);
    assert.deepEqual(rEmpty.entries, []);
    assert.equal(rEmpty.more, false);

    fs.mkdirSync(path.join(pop, ".git"));
    fs.mkdirSync(path.join(pop, "sub"));
    fs.writeFileSync(path.join(pop, "file10.txt"), "1234");
    fs.writeFileSync(path.join(pop, "file2.txt"), "12");
    fs.writeFileSync(path.join(pop, "-leading.txt"), "x");
    fs.writeFileSync(path.join(pop, ".hidden"), "h");

    const rPop = await listDir(pop, null);
    assert.equal(rPop.more, false);
    assert.deepEqual(
      rPop.entries.map((e) => e.name),
      ["sub", "-leading.txt", ".hidden", "file2.txt", "file10.txt"],
    );
    assert.equal(rPop.entries[0].dir, true);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(pop, { recursive: true, force: true });
  }
});

test("walkthrough turn.sh does not treat untracked -delete filename as find flag", () => {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "vnh-turn-"));
  const repo = path.join(td, "repo");
  fs.mkdirSync(repo);
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "keep.txt"), "safe");
    fs.writeFileSync(path.join(repo, "-delete"), "tricky");
    const payload = JSON.stringify({ cwd: repo, session_id: "sess-1", prompt: "hello" });
    execFileSync("sh", [path.join(ROOT, "mods", "walkthrough", "hooks", "turn.sh"), "start"], {
      input: payload,
      env: { ...process.env, HOME: td },
    });
    assert.equal(fs.existsSync(path.join(repo, "keep.txt")), true);
    assert.equal(fs.existsSync(path.join(repo, "-delete")), true);
  } finally {
    fs.rmSync(td, { recursive: true, force: true });
  }
});

test("lib/jq.sh verifies checksum and status/agy.sh caches title across ticks", () => {
  const out = execFileSync(
    "sh",
    ["-c", 'TOOLKIT_ROOT="$1"; . "$TOOLKIT_ROOT/lib/jq.sh"; printf \'{"ok":true}\' | jq -r .ok', "t", ROOT],
    { encoding: "utf8" },
  ).trim();
  assert.equal(out, "true");

  const td = fs.mkdtempSync(path.join(os.tmpdir(), "vnh-agy-"));
  try {
    const agyDir = path.join(td, ".gemini", "antigravity-cli");
    fs.mkdirSync(agyDir, { recursive: true });
    const hist = path.join(agyDir, "history.jsonl");
    const cid = "11111111-2222-3333-4444-555555555555";
    fs.writeFileSync(hist, JSON.stringify({ conversationId: cid, display: "Cached Title" }) + "\n");

    const env = { ...process.env, HOME: td, HC_TERMINAL_ID: "term1", HERDR_APP_HOME: td };
    const tick = JSON.stringify({ conversation_id: cid, model: { display_name: "Gemini 2.5" }, context_window: { used_percentage: 25 } });
    execFileSync("sh", [path.join(ROOT, "status", "agy.sh")], { input: tick, env });
    const first = JSON.parse(fs.readFileSync(path.join(td, ".cache", "herdr-status", "term1.json"), "utf8"));
    assert.equal(first.title, "Cached Title");
    assert.equal(first.ctx, 25);

    // Delete history.jsonl: warm tick must keep cached title without needing history.jsonl.
    fs.rmSync(hist);
    execFileSync("sh", [path.join(ROOT, "status", "agy.sh")], { input: tick, env });
    const second = JSON.parse(fs.readFileSync(path.join(td, ".cache", "herdr-status", "term1.json"), "utf8"));
    assert.equal(second.title, "Cached Title");
  } finally {
    fs.rmSync(td, { recursive: true, force: true });
  }
});

// External editors, OS reveal/open, clipboard copy, and sending @path mentions to agents.
import { spaces, panes, agents, focused, exec, theme, window, appHome, run, notify } from "herdr";

const psQuote = (s) => "'" + s.replaceAll("'", "''") + "'";

function relTo(root, abs) {
  if (!root || !abs) return null;
  const a = abs.replace(/\\/g, "/"), r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (a === r) return "";
  return a.startsWith(r + "/") ? a.slice(r.length + 1) : null;
}

export function openInHelix(abs, on, root) {
  if (on) { notify({ title: "Helix opens the files of this computer only", level: "info", timeout: 3000 }); return; }
  const space = spaces().find((s) => s.active);
  if (!space || !abs) return;
  const back = space.tabs.find((t) => t.active)?.id ?? "";
  run("tab.new", { space: space.id, folder: root || abs.slice(0, abs.lastIndexOf("/")) || "/", name: abs.split("/").pop().slice(0, 40),
    argv: ["sh", "-lc", 'exec python3 -I "$1" "$2" "$3" "$4"', "hx", `${appHome()}/mods/vnh-filetree/hx-open.py`, abs, back, String(theme().background ?? "")] });
}

export function openInNvim(abs, on, root) {
  if (on) { notify({ title: "Neovim opens the files of this computer only", level: "info", timeout: 3000 }); return; }
  const space = spaces().find((s) => s.active);
  if (!space || !abs) return;
  const back = space.tabs.find((t) => t.active)?.id ?? "";
  run("tab.new", { space: space.id, folder: root || abs.slice(0, abs.lastIndexOf("/")) || "/", name: abs.split("/").pop().slice(0, 40),
    argv: ["sh", "-lc", 'exec python3 -I "$1" "$2" "$3"', "nvim", `${appHome()}/mods/vnh-filetree/nvim-open.py`, abs, back] });
}

export async function openExternal(abs) {
  const platform = window()?.platform;
  const r = platform === "macos" ? await exec("open", ["--", abs])
    : platform === "windows" ? await exec("powershell", ["-NoProfile", "-Command", `Invoke-Item -LiteralPath ${psQuote(abs)}`])
    : await exec("xdg-open", [abs]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "No app opens this file");
}

export async function revealExternal(abs) {
  const platform = window()?.platform;
  if (platform === "macos") await exec("open", ["-R", "--", abs]);
  else if (platform === "windows") await exec("explorer.exe", [`/select,${abs.replace(/\//g, "\\")}`]);
  else await exec("xdg-open", [abs.replace(/\/[^/]*$/, "") || "/"]);
}

export function copy(cx, text) {
  cx.write_to_clipboard(text);
  notify({ title: "Copied", body: text, level: "info", timeout: 2000 });
}

let savedClipboard = undefined;
let restoreSeq = 0;

// Types "@path " into the agent of the shown tab, through the clipboard, then restores the original clipboard safely.
export function sendToAgent(cx, abs) {
  const f = focused(), fp = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const inTab = agents().filter((a) => a.tab === f?.tab);
  const address = (fp?.status && fp.terminal) || (inTab.find((a) => a.focused) ?? inTab[0])?.address || agents().find((a) => a.focused)?.address;
  if (!address) { notify({ title: "No agent in this tab", body: "Start one, then send the path again", level: "warning", timeout: 3000 }); return; }
  const cwd = panes().find((p) => p.terminal === address)?.cwd;
  const rel = relTo(cwd, abs), path = rel || abs;
  const text = `@${/\s/.test(path) ? `"${path}"` : path} `;
  if (savedClipboard === undefined) savedClipboard = cx.read_from_clipboard();
  const seq = ++restoreSeq;
  cx.write_to_clipboard(text);
  run("pane.focus", { terminal: address });
  run("terminal.paste");
  cx.timer.after(600, (cx) => {
    if (seq !== restoreSeq) return;
    if (savedClipboard !== undefined && cx.read_from_clipboard() === text) cx.write_to_clipboard(savedClipboard);
    savedClipboard = undefined;
  });
}

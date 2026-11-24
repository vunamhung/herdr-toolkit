// Right-click menu for a row of the Files panel (vnh-files).
// props: { root, path (relative to root), dir, on (machine or null), space, gone (deleted in git) }
// Copy paths, reveal / open, new terminal here, new file / folder, rename, move to Trash.
// File operations never overwrite; afterwards the panel is asked to refresh ("vnh-files.refresh").
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, exec, run, notify, checking } from "herdr";

const base = (p) => p.slice(p.lastIndexOf("/") + 1);
const parent = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export default class FilesMenu extends View {
  init(_props, cx) {
    this.mode = "list"; // list | rename | new-file | new-folder | trash
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "" });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.apps = { code: false };
    cx.timer.after(50, () => this.handle.focus());
    if (checking() || props()?.on) return;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'test -d "/Applications/Visual Studio Code.app" && echo code; true']).catch(() => null);
      this.apps.code = (r?.stdout ?? "").includes("code");
      cx.notify();
    });
  }

  get p() { return props() ?? {}; }
  abs(rel = this.p.path) { return rel ? `${this.p.root}/${rel}` : this.p.root; }
  close() { closeOverlay(this.p.overlay); }

  async copy(text, label) {
    const r = await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text]).catch(() => null);
    if (r?.code === 0) notify({ title: `Copied ${label}`, body: text, level: "success", timeout: 2000 });
    else notify({ title: "Copy failed", body: text, level: "error" });
    this.close();
  }

  open(args) {
    exec("open", args).catch(() => {});
    this.close();
  }

  terminal() {
    const folder = this.p.dir ? this.abs() : this.abs(parent(this.p.path));
    run("tab.new", { space: this.p.space ?? undefined, folder });
    this.close();
  }

  ask(mode, cx) {
    this.mode = mode;
    const name = base(this.p.path);
    this.input.set_value(mode === "rename" ? name : "");
    this.input.focus();
    cx.notify();
  }

  // Runs a shell snippet on the panel's machine; $1.. are args. Exit 3 means "already exists".
  async sh(script, args, what) {
    const r = await exec("sh", ["-c", script, "op", ...args], { on: this.p.on ?? null }).catch((e) => ({ code: -1, stderr: String(e) }));
    if (r.code === 0) { run("vnh-files.refresh"); return true; }
    notify({ title: `${what} failed`, body: r.code === 3 ? "Something with that name already exists." : (r.stderr || "").trim() || "Unknown error", level: "error" });
    return false;
  }

  async submit(cx) {
    const name = this.input.value().trim();
    if (this.mode === "trash") return this.trash(cx);
    if (!name || name.includes("/") || name === "." || name === "..") { notify({ title: "Invalid name", body: name || "(empty)", level: "warning" }); return; }
    const here = this.p.dir ? this.p.path : parent(this.p.path);
    if (this.mode === "rename") {
      const target = this.abs(parent(this.p.path) ? `${parent(this.p.path)}/${name}` : name);
      if (name !== base(this.p.path)) await this.sh('[ -e "$2" ] && exit 3; mv -n -- "$1" "$2"', [this.abs(), target], "Rename");
    } else if (this.mode === "new-file") {
      await this.sh('[ -e "$1" ] && exit 3; mkdir -p -- "$(dirname -- "$1")" && : > "$1"', [this.abs(here ? `${here}/${name}` : name)], "New file");
    } else if (this.mode === "new-folder") {
      await this.sh('[ -e "$1" ] && exit 3; mkdir -p -- "$1"', [this.abs(here ? `${here}/${name}` : name)], "New folder");
    }
    this.close();
  }

  // Finder's Trash (Put Back works) on this computer; elsewhere ~/.Trash with a unique name.
  async trash(cx) {
    const target = this.abs();
    if (!this.p.on) {
      const r = await exec("osascript", ["-e", "on run argv", "-e", 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', "-e", "end run", target]).catch(() => null);
      if (r?.code === 0) { run("vnh-files.refresh"); this.close(); return; }
    }
    await this.sh('mkdir -p "$HOME/.Trash" && mv -n -- "$1" "$HOME/.Trash/$(basename -- "$1").$(date +%s)"', [target], "Move to Trash");
    this.close();
  }

  item(t, id, icon, label, action, opts = {}) {
    return h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(6).cursor_pointer()
      .text_color(opts.danger ? t.ansi1 : t.foreground).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => action(cx))
      .child(svg(`mods/vnh-files-menu/${icon}.svg`).size(14).flex_none().text_color(opts.danger ? t.ansi1 : t.muted))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(opts.hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(opts.hint)));
  }

  sep(t) { return div().h(1).mx(6).my(3).bg(t.border); }

  render() {
    const t = theme(), p = this.p, name = base(p.path ?? ""), local = !p.on;
    const box = v_flex().id("files-menu").track_focus(this.handle).w_full().p(4).gap(1).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "enter" && this.mode === "trash") { cx.stop_propagation(); this.trash(cx); return; }   // the question's main button is the default
        if (e.key !== "escape") return;
        cx.stop_propagation();
        if (this.mode === "list") this.close(); else { this.mode = "list"; this.handle.focus(); cx.notify(); }
      })
      .child(div().px(8).py(5).text_size(11).text_color(t.dim).truncate().child(p.path || "/"));
    if (this.mode === "rename" || this.mode === "new-file" || this.mode === "new-folder") {
      const title = this.mode === "rename" ? `Rename ${p.dir ? "folder" : "file"}` : this.mode === "new-file" ? "New file in" : "New folder in";
      const where = this.mode === "rename" ? "" : ` ${(p.dir ? p.path : parent(p.path)) || "/"}`;
      return box
        .child(div().px(8).text_size(12).text_color(t.muted).child(`${title}${where}`))
        .child(h_flex().h(32).mx(6).px(8).items_center().rounded(7).border_1().border_color(t.accent).bg(t.background)
          .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
        .child(div().px(8).py(4).text_size(11).text_color(t.dim).child("Enter to confirm · Esc to go back"));
    }
    if (this.mode === "trash") {
      return box
        .child(div().px(8).py(4).text_size(12.5).child(`Move "${name}" to the Trash?`))
        .child(h_flex().px(6).py(4).gap(6)
          .child(div().id("trash-yes").flex_1().h(28).flex().items_center().justify_center().rounded(6).cursor_pointer().bg(t.ansi1).text_color("#ffffff")
            .border_1().border_color("#ffffff66").on_click((_e, cx) => this.trash(cx)).child("Move to Trash"))
          .child(div().id("trash-no").flex_1().h(28).flex().items_center().justify_center().rounded(6).cursor_pointer().bg(t.hover)
            .on_click((_e, cx) => { this.mode = "list"; cx.notify(); }).child("Cancel")));
    }
    return box
      .child(this.item(t, "m-copy-rel", "copy", "Copy relative path", () => this.copy(p.path, "relative path")))
      .child(this.item(t, "m-copy-abs", "copy", "Copy absolute path", () => this.copy(this.abs(), "path")))
      .child(this.item(t, "m-copy-at", "copy", "Copy as @mention", () => this.copy(`@${p.path}${p.dir ? "/" : ""}`, "@mention"), { hint: "Claude" }))
      .child(this.sep(t))
      .when(local, (el) => el.child(this.item(t, "m-reveal", "eye", "Reveal in Finder", () => this.open(["-R", this.abs()]))))
      .when(local && !p.dir && !p.gone, (el) => el.child(this.item(t, "m-open", "external", "Open with default app", () => this.open([this.abs()]))))
      .when(local && this.apps.code, (el) => el.child(this.item(t, "m-code", "code", "Open in VS Code", () => this.open(["-a", "Visual Studio Code", this.abs()]))))
      .child(this.item(t, "m-term", "terminal", "New terminal here", () => this.terminal()))
      .child(this.sep(t))
      .child(this.item(t, "m-new-file", "plus", "New file…", (cx) => this.ask("new-file", cx)))
      .child(this.item(t, "m-new-folder", "folder-plus", "New folder…", (cx) => this.ask("new-folder", cx)))
      .when(!p.gone, (el) => el.child(this.item(t, "m-rename", "square-pen", "Rename…", (cx) => this.ask("rename", cx))))
      .when(!p.gone, (el) => el.child(this.sep(t)).child(this.item(t, "m-trash", "trash", "Move to Trash…", (cx) => { this.mode = "trash"; this.handle.focus(); cx.notify(); }, { danger: true })));
  }
}

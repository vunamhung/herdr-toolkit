// A rendered Markdown file in its own tab, opened by the Files panel's eye button.
// props: { path: absolute file path, on: machine or null, back: tab to return to on close }
// Keys (the tab takes the keyboard when it opens): Esc or Space closes it and goes back, giving the
// keyboard to the Files panel so Space can open the next file (Quick Look style).
// Re-reads the file every 2 s while the Herdr window is active (a file read, no process), so edits
// show up. Links: web URLs open in the browser; a relative .md link opens in another tab like this.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { theme, props, readTextFile, run, spaces, window, exec, panes, nextCommand, layout } from "herdr";

const MAX = 1_000_000; // readTextFile's limit
const FONT = "PragmataPro";

const dirOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
function resolve(dir, rel) {
  const parts = (rel.startsWith("/") ? rel : `${dir}/${rel}`).split("/");
  const out = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return "/" + out.join("/");
}

export default class MarkdownView extends View {
  init(_props, cx) {
    this.text = null;
    this.error = null;
    this.kb = cx.focus_handle();
    // Take the keyboard on open, and again whenever Herdr hands it to this pane.
    cx.timer.after(150, () => this.kb.focus());
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); if (c === "focus") { this.kb.focus(); cx.notify(); } } });
    this.load(cx);
    cx.timer.every(2000, (cx) => { if (window()?.active) this.load(cx); });
  }

  load(cx) {
    const { path, on } = props() ?? {};
    if (!path || this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(path, { on: on ?? null });
        const next = text === null ? null : text;
        const error = text === null ? "This file is no longer available" : null;
        if (next !== this.text || error !== this.error) { this.text = next; this.error = error; cx.notify(); }
      } catch (e) {
        const error = String(e).includes("too large") ? "File too large to render (over 1 MiB)" : "Cannot read this file";
        if (error !== this.error) { this.error = error; cx.notify(); }
      } finally { this.loading = false; }
    });
  }

  close() {
    // One close per tab: a repeated or re-delivered key would close an already closed tab
    // ("tab.close failed: no tab …").
    if (this.closing) return;
    const mine = panes().filter((p) => p.mod === "vnh-markdown");
    const me = mine.find((p) => p.pane === props()?.pane) ?? mine.find((p) => p.focused);
    if (!me) return;
    this.closing = true;
    run("tab.close", { id: me.tab, confirmed: true });
    const back = props()?.back;
    if (back) run("tab.select", { id: back });
    // The Files panel takes the keyboard back (when the layout's Files panel is vnh-files).
    const walk = (n) => n?.content?.mod === "vnh-files" || (n?.children ?? []).some(walk);
    if (walk(layout())) run("vnh-files.focus");
  }

  openLink(url) {
    const { path, on } = props() ?? {};
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) { exec("open", [url]).catch(() => {}); return; } // http(s), mailto…
    const [file] = url.split("#");
    if (!file) return; // an in-page anchor
    const target = resolve(dirOf(path), decodeURIComponent(file));
    if (/\.(md|markdown|mdx)$/i.test(target)) {
      const space = spaces().find((s) => s.active)?.id;
      run("tab.new", { space, name: target.split("/").pop(), mod: "vnh-markdown", props: { path: target, on: on ?? null } });
    } else {
      exec("open", [target]).catch(() => {});
    }
  }

  render() {
    const t = theme(), { path } = props() ?? {};
    const name = path ? path.split("/").pop() : "";
    return v_flex().id("md-view").track_focus(this.kb).size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .on_mouse_down("left", () => this.kb.focus())
      .on_key_down((e, cx) => {
        const m = e.modifiers ?? {};
        if (m.control || m.alt || m.platform || m.shift) return;
        if (e.key === "escape" || e.key === "space") { cx.stop_propagation(); if (!e.is_held) this.close(); }
      })
      .child(h_flex().h(34).flex_none().px(16).gap(8).items_center().border_b(1).border_color(t.border).text_size(12).font_family(FONT)
        .child(div().flex_none().font_semibold().child(name))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(path ? dirOf(path) : "")))
      .child(div().id("md-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        // PragmataPro for the rendered text (the person's UI font); code blocks inherit it.
        .child(div().w_full().max_w(880).mx_auto().px(28).py(20).text_size(14).font_family(FONT)
          .child(this.error
            ? div().text_color(t.dim).child(this.error)
            : this.text === null
              ? div().text_color(t.dim).child("Loading…")
              : TextView.markdown(`md-${path}`, this.text.length > MAX ? this.text.slice(0, MAX) : this.text || " ")
                .selectable(true).on_link_click((url) => this.openLink(url)))));
  }
}

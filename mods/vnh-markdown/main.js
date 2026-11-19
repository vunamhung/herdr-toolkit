// A rendered Markdown file in its own tab, opened by the Files panel's eye button.
// props: { path: absolute file path, on: machine or null }
// Re-reads the file every 2 s while the Herdr window is active (a file read, no process), so edits
// show up. Links: web URLs open in the browser; a relative .md link opens in another tab like this.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { theme, props, readTextFile, run, spaces, window, exec } from "herdr";

const MAX = 1_000_000; // readTextFile's limit

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
    return v_flex().id("md-view").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(h_flex().h(34).flex_none().px(16).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().flex_none().font_semibold().child(name))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(path ? dirOf(path) : "")))
      .child(div().id("md-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(div().w_full().max_w(880).mx_auto().px(28).py(20).text_size(14)
          .child(this.error
            ? div().text_color(t.dim).child(this.error)
            : this.text === null
              ? div().text_color(t.dim).child("Loading…")
              : TextView.markdown(`md-${path}`, this.text.length > MAX ? this.text.slice(0, MAX) : this.text || " ")
                .selectable(true).on_link_click((url) => this.openLink(url)))));
  }
}

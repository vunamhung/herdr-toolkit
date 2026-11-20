// A rendered Markdown file in its own tab, opened by the Files panel's eye button.
// props: { path: absolute file path, on: machine or null, back: tab to return to on close }
// Keys (the tab takes the keyboard when it opens): Esc or Space closes it and goes back, giving the
// keyboard to the Files panel so Space can open the next file (Quick Look style).
// Re-reads the file every 2 s while the Herdr window is active (a file read, no process), so edits
// show up. Links: web URLs open in the browser; a relative .md link opens in another tab like this.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { theme, props, readTextFile, run, spaces, window, exec, panes, nextCommand, layout, shared, setShared } from "herdr";

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
    // VNH: what this tab shows. One Markdown tab per space: opening another file asks this copy to
    // switch (shared "vnh.markdown.open", naming its pane) instead of adding a tab.
    this.doc = { path: props()?.path ?? null, on: props()?.on ?? null, back: props()?.back ?? null };
    this.seenOpen = shared("vnh.markdown.open")?.n ?? 0;
    this.kb = cx.focus_handle();
    // This copy's own pane. A mod pane isn't told its id, so each copy claims an unclaimed
    // vnh-markdown pane (the one in the active tab first) in shared "vnh.markdown.panes", retrying
    // until its tab exists. Closing uses it, never "whichever Markdown pane is focused".
    this.myPane = null; this.showing = false;
    const claim = () => {
      const all = panes().filter((p) => p.mod === "vnh-markdown"), live = new Set(all.map((p) => p.pane));
      const taken = Object.fromEntries(Object.entries(shared("vnh.markdown.panes") ?? {}).filter(([pane]) => live.has(pane)));
      const active = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id;
      const free = all.filter((p) => !taken[p.pane]);
      const mine = free.find((p) => p.tab === active) ?? free[free.length - 1];
      if (!mine) return false;
      this.myPane = mine.pane;
      setShared("vnh.markdown.panes", { ...taken, [mine.pane]: props()?.path ?? true });
      return true;
    };
    let tries = 0;
    const tryClaim = () => { if (!this.myPane && !claim() && ++tries < 20) cx.timer.after(100, tryClaim); };
    tryClaim();
    // Take the keyboard when this tab shows (on open, and each time it is selected again), never
    // from elsewhere: grabbing it while you typed in a prompt made that Space close the tab.
    cx.timer.every(250, () => {
      const me = this.myPane && panes().find((p) => p.pane === this.myPane);
      const active = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id;
      const showing = Boolean(me && window()?.active && active === me.tab);
      if (showing && !this.showing) this.kb.focus();
      this.showing = showing;
      const ask = shared("vnh.markdown.open");
      if (ask && ask.n > this.seenOpen && this.myPane && ask.pane === this.myPane) {
        this.seenOpen = ask.n;
        this.switchTo(ask.path, ask.on ?? null, ask.back ?? null, cx);
      }
    });
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); if (c === "focus") { this.kb.focus(); cx.notify(); } else if (c === "close" && this.showing) this.close(); } });
    this.load(cx);
    cx.timer.every(2000, (cx) => { if (window()?.active) this.load(cx); });
  }

  // Shows another file in this tab, renamed after it; `back` (when given) is the tab Esc returns to.
  switchTo(path, on, back, cx) {
    if (!path) return;
    this.doc = { path, on, back: back ?? this.doc.back };
    this.text = null; this.error = null;
    const me = this.myPane && panes().find((p) => p.pane === this.myPane);
    if (me) { run("tab.rename", { id: me.tab, name: path.split("/").pop() }); run("tab.select", { id: me.tab }); }
    this.kb.focus();
    this.load(cx);
    cx.notify();
  }

  load(cx) {
    const { path, on } = this.doc;
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
    const me = mine.find((p) => p.pane === this.myPane);
    if (!me) return;
    this.closing = true;
    run("tab.close", { id: me.tab, confirmed: true });
    const back = this.doc.back;
    if (back) run("tab.select", { id: back });
    // The Files panel (vnh-files or filetree) takes the keyboard back.
    const has = (mod) => { const walk = (n) => n?.content?.mod === mod || (n?.children ?? []).some(walk); return walk(layout()); };
    if (has("vnh-files")) run("vnh-files.focus");
    else if (has("filetree")) run("filetree.focus");
  }

  openLink(url, cx) {
    const { path, on } = this.doc;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) { exec("open", [url]).catch(() => {}); return; } // http(s), mailto…
    const [file] = url.split("#");
    if (!file) return; // an in-page anchor
    const target = resolve(dirOf(path), decodeURIComponent(file));
    if (/\.(md|markdown|mdx)$/i.test(target)) {
      this.switchTo(target, on ?? null, null, cx); // the same tab, as every preview
    } else {
      exec("open", [target]).catch(() => {});
    }
  }

  render() {
    const t = theme(), { path } = this.doc;
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
                .selectable(true).on_link_click((url, cx) => this.openLink(url, cx)))));
  }
}

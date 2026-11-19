// Generated from lib/xmux/code-viewer.js. Run node scripts/sync-common.mjs.
// Native Editor owns ordinary source selection, syntax and keyboard navigation.
// Decorated text uses one selectable TextView per column, never per syntax run
// or virtual row: the native selection then retains offscreen text and does not
// interleave the two sides of a split diff.
import { div } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState, TextView } from "gpui-base";
import { theme } from "herdr";

export function newCode({ value, language, wrap = false, font, size }) {
  const t = theme();
  return EditorState.new({ value, language, readonly: true, soft_wrap: wrap,
    font_family: font, font_size: size,
    syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4,
      type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
}

export const CodeEditor = (state) => v_flex().flex_1().min_h(0)
  .child(Editor.new(state).flex_1().min_h(0));

export const escapeCode = (text) => String(text).replace(/&/g, "&amp;")
  .replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function rowLook(kind, t = theme()) {
  const color = kind === "+" || kind === "incoming" ? t.ansi2 : kind === "-" ? t.ansi1
    : kind === "yours" ? t.accent : null;
  return { color: color ?? (kind === "@" ? t.accent : t.foreground),
    background: color ? `${color.slice(0, 7)}26` : kind === "@" || kind === "marker" ? t.raised : null };
}

// The HTML minifier preserves whitespace only when its immediate parent is
// <pre>. Keep all code directly under <pre>; line colors are separate layers.
// The minifier parses once and writes pre text raw; escape twice for its
// second HTML parse, including literal entity strings in source.
// Empty <b> avoids HTML's special removal of an initial newline after <pre>.
export function columnHtml(rows) {
  return `<pre><b></b>${rows.map((r) => escapeCode(escapeCode((r.text ?? "").replace(/\r$/, "")))).join("\n")}</pre>`;
}

function displayColumns(text) {
  let width = 0;
  for (const char of text) width += char === "\t" ? 4 - width % 4 : char.codePointAt(0) > 255 ? 2 : 1;
  return width;
}

export function CodeRows({ id, columns, font, size, gutter, minWidth = 300 }) {
  const t = theme();
  const height = Math.round(size * 1.6);
  const column = (rows, index) => {
    const widest = rows.reduce((n, r) => Math.max(n, displayColumns(r.text ?? "")), 0);
    const numbers = v_flex().flex_none().children(rows.map((row, i) =>
      div().h(height).flex_none().text_color(t.dim)
        .when(Boolean(rowLook(row.kind, t).background), (el) => el.bg(rowLook(row.kind, t).background))
        .child(gutter ? gutter(row, i, index) : div().w(size * 8).text_right().pr(8)
          .child([row.old ?? "", row.next ?? "", ["+", "-"].includes(row.kind) ? row.kind : ""].join("  ")))));
    return h_flex().flex_1().min_w(0).h_full()
      .when(index > 0, (el) => el.border_l(1).border_color(t.border))
      .child(div().id(`${id}-x-${index}`).size_full().overflow_x_scrollbar().mode("scrolling")
        .child(h_flex().items_start().min_w(Math.max(minWidth, widest * size * 0.7 + size * 9))
          .child(numbers)
          .child(div().w(Math.max(minWidth, widest * size * 0.7 + size)).flex_none().relative()
            .child(v_flex().absolute().inset_0().children(rows.map((row) =>
              div().h(height).flex_none().when(Boolean(rowLook(row.kind, t).background),
                (el) => el.bg(rowLook(row.kind, t).background)))))
            .child(TextView.html(`${id}-text-v1-${index}-${t.foreground}`, columnHtml(rows))
              .selectable(true).scrollable(false).w_full().relative()
              .font_family(font).text_size(size).text_color(t.foreground)
              .line_height(`${height}px`).whitespace_nowrap()))));
  };
  // One vertical viewport keeps split columns aligned. Each side scrolls
  // horizontally on its own, without changing the text's selection coordinates.
  return div().id(`${id}-y`).flex_1().min_h(0).min_w(0)
    .overflow_y_scrollbar().mode("scrolling")
    .font_family(font).text_size(size).line_height(`${height}px`)
    .child(h_flex().items_start().w_full().h(columns[0].length * height)
      .children(columns.map(column)));
}

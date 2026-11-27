// Generated from lib/xmux/dialog-titlebar.js. Run node scripts/sync-common.mjs.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";

export const DIALOG_TITLEBAR_HEIGHT = 32;
export const DIALOG_TITLEBAR_GRIP = 4;

export function dialogTitlebar(t, id) {
  return h_flex().id(id).size_full().px(8).pb(DIALOG_TITLEBAR_GRIP).gap(8).items_center().bg(t.chrome)
    .border_b(1).border_color(t.border).text_size(12).text_color(t.foreground);
}

export function dialogTitlebarButton(t, id, label, tooltip, action) {
  return div().id(id).min_w(28).h(22).px(6).rounded(4).flex_none().flex().items_center().justify_center()
    .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
    .tooltip(tooltip).accessibility_label(tooltip)
    .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
    .on_click(action).child(label);
}

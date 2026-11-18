import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { closeOverlay, focused, panes, props, run, setShared, shared, terminals, theme } from "herdr";
import { floatingTerminalTitle } from "./shared/tab-title.js";

const STATE = "xmux.quick-dialog";

export default class QuickDialogTitlebar extends View {
  restore() {
    const { terminal, origin } = props() ?? {};
    if (focused()?.terminal && focused().terminal !== terminal) return;
    if (origin?.pane && panes().some(p => p.pane === origin.pane)) run("pane.focus", { pane: origin.pane });
    else if (origin?.terminal && terminals().some(t => t.address === origin.terminal && t.state === "live")) run("pane.focus", { terminal: origin.terminal });
  }

  dismiss(kill) {
    const { terminal, overlay } = props();
    if (kill) run("terminal.kill", { terminal });
    if (shared(STATE)?.overlay === overlay) setShared(STATE, kill ? null : { ...shared(STATE), overlay: null });
    closeOverlay(overlay);
    this.restore();
  }

  close() {
    // Native layout changes and terminal exit can remove the window too.
    // Never kill here: hiding the window removes this titlebar as well.
    const { overlay } = props() ?? {};
    if (shared(STATE)?.overlay === overlay) setShared(STATE, { ...shared(STATE), overlay: null });
  }

  button(t, id, glyph, label, action) {
    return div().id(id).w(28).h(24).rounded(4).flex_none().flex().items_center().justify_center()
      .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .tooltip(label).accessibility_label(label)
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_click(action).child(glyph);
  }

  render() {
    const t = theme();
    const address = props()?.terminal;
    const terminal = terminals().find(entry => entry.address === address);
    const title = floatingTerminalTitle(terminal);
    const folder = terminal?.foreground?.cwd || terminal?.cwd || "";
    return h_flex().id("quick-dialog-titlebar").size_full().px(8).gap(8).items_center().bg(t.chrome)
      .border_b(1).border_color(t.border).text_size(12).text_color(t.foreground)
      .child(svg("icons/shell.svg").size(14).flex_none().text_color(t.muted))
      .child(h_flex().min_w(0).flex_1().gap(8).items_center()
        .child(div().min_w(0).truncate().tooltip(title).child(title))
        .when(Boolean(folder), el => el.child(div().min_w(0).truncate().text_color(t.dim).tooltip(folder).child(folder))))
      .child(this.button(t, "quick-dialog-hide", "−", "Hide terminal (⌘`)", () => this.dismiss(false)))
      .child(this.button(t, "quick-dialog-close", "×", "Close terminal", () => this.dismiss(true)));
  }
}

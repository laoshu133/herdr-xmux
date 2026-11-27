import { View, div, svg } from "gpui-kit";
import { closeOverlay, props, run, setShared, shared, terminals, theme } from "herdr";
import { floatingTerminalTitle } from "./shared/tab-title.js";
import { DIALOG_TITLEBAR_GRIP, dialogTitlebar, dialogTitlebarButton } from "./shared/dialog-titlebar.js";

const STATE = "xmux.quick-dialog";

export default class QuickDialogTitlebar extends View {
  dismiss(kill) {
    const { terminal, overlay } = props();
    if (kill) run("terminal.kill", { terminal });
    if (shared(STATE)?.overlay === overlay) setShared(STATE, kill ? null : { ...shared(STATE), overlay: null });
    closeOverlay(overlay);
  }

  close() {
    // Native layout changes and terminal exit can remove the window too.
    // Never kill here: hiding the window removes this titlebar as well.
    const { overlay } = props() ?? {};
    if (shared(STATE)?.overlay === overlay) setShared(STATE, { ...shared(STATE), overlay: null });
  }

  render() {
    const t = theme();
    const address = props()?.terminal;
    const terminal = terminals().find(entry => entry.address === address);
    const title = floatingTerminalTitle(terminal);
    return dialogTitlebar(t, "quick-dialog-titlebar").pt(DIALOG_TITLEBAR_GRIP)
      // Keep the dialog frame from taking focus from its terminal.
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .child(svg("icons/shell.svg").size(14).flex_none().text_color(t.muted))
      .child(div().min_w(0).flex_1().truncate().tooltip(title).child(title))
      .child(dialogTitlebarButton(t, "quick-dialog-hide", "−", "Hide terminal (⌘`)", () => this.dismiss(false)))
      .child(dialogTitlebarButton(t, "quick-dialog-close", "×", "Close terminal", () => this.dismiss(true)));
  }
}

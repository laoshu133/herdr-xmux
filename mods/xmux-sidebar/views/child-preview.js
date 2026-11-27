import { div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, closeOverlay, panes, props, run, spaces, terminals, theme } from "herdr";
import { forgetChildPreview, rememberChildPreview, updateChildPreviewTitleFocus } from "../shared/child-preview.js";
import { dialogTitlebar, dialogTitlebarButton } from "../shared/dialog-titlebar.js";
import { floatingTerminalTitle } from "../shared/tab-title.js";

const STATUS = { working: "working", blocked: "needs you", done: "finished", idle: "idle", error: "error" };
const KEEP_PLACEMENTS = Symbol.for("xmux.child-preview.keep-placements");

export function keepDestination(terminal, allPanes = panes(), allTerminals = terminals(), allSpaces = spaces()) {
  if (!terminal) return null;
  const machine = terminal.includes("/") ? terminal.split("/")[0] : null;
  const localSpaces = allSpaces.filter(space => (space.machine ?? null) === machine);
  const seen = new Set();
  for (let address = allTerminals.find(entry => entry.address === terminal)?.parent;
    address && !seen.has(address);
    address = allTerminals.find(entry => entry.address === address)?.parent) {
    seen.add(address);
    const tab = allPanes.find(pane => pane.terminal === address)?.tab;
    const owner = localSpaces.find(space => space.tabs.some(entry => entry.id === tab));
    if (owner) return { space: owner, parentTab: tab };
  }
  const space = localSpaces.find(space => space.active) ?? localSpaces[0];
  return space ? { space } : null;
}

// Herdr creates the pane asynchronously. Match by the terminal address, which
// remains stable if the user switches tabs or creates another one meanwhile.
export function placeKeptTabs(allSpaces, allPanes, tabMoveIndex) {
  const pending = globalThis[KEEP_PLACEMENTS];
  if (!pending?.size) return;
  for (const [terminal, placement] of pending) {
    if (Date.now() > placement.expires) {
      pending.delete(terminal);
      continue;
    }
    const tab = allPanes.find(pane => pane.terminal === terminal)?.tab;
    if (!tab) continue;
    const tabs = allSpaces.find(space => space.id === placement.space)?.tabs;
    if (!tabs?.some(item => item.id === tab)) continue;
    pending.delete(terminal);
    const index = tabMoveIndex(tabs, tab, placement.targetTab, placement.after);
    if (index !== null) run("tab.move", { id: tab, index });
  }
}

export function keepChildTerminal(terminal, destination, target = null) {
  const targetTab = target?.id ?? destination.parentTab;
  if (targetTab) {
    const pending = globalThis[KEEP_PLACEMENTS] ??= new Map();
    pending.set(terminal, { space: destination.space.id, targetTab, after: target?.after ?? true, expires: Date.now() + 30000 });
  }
  if (!destination.space.active) run("space.select", { id: destination.space.id });
  run("terminal.keep", { terminal });
}

export class ChildPreview {
  init(_given, cx) {
    const { overlay, terminal } = props() ?? {};
    this.overlay = overlay;
    this.terminal = terminal;
    if (!overlay) return;
    rememberChildPreview(overlay, terminal);
    this.focus = cx.focus_handle();
    this.focus.focus();
    updateChildPreviewTitleFocus(overlay, this.focus.is_focused());
    // The native titlebar focus handle has no JS focus-change callback.
    cx.timer.every(100, () => updateChildPreviewTitleFocus(overlay, this.focus.is_focused()));
  }

  close() {
    if (this.overlay) forgetChildPreview(this.overlay);
  }

  openTerminal() {
    const terminal = this.terminal;
    const allPanes = panes();
    const pane = allPanes.find(item => item.terminal === terminal);
    if (pane) {
      run("pane.focus", { pane: pane.pane });
    } else {
      const keep = keepDestination(terminal, allPanes, terminals(), spaces());
      if (!keep) return;
      keepChildTerminal(terminal, keep);
    }
    closeOverlay(this.overlay);
  }

  render() {
    if (!this.focus) return div();
    const t = theme();
    const terminal = this.terminal;
    const allTerminals = terminals();
    const entry = allTerminals.find(item => item.address === terminal);
    const parent = allTerminals.find(item => item.address === entry?.parent);
    const status = agents().find(agent => agent.address === terminal)?.status ?? entry?.status;
    const program = entry?.program;
    const icon = program?.icon && (program.tint
      ? svg(program.icon).size(14).text_color(t.muted)
      : image(program.icon).size(14));
    const allPanes = panes();
    const hasPane = allPanes.some(pane => pane.terminal === terminal);
    const keep = hasPane ? null : keepDestination(terminal, allPanes, allTerminals, spaces());
    const title = entry?.name || (entry ? floatingTerminalTitle(entry) : terminal);

    return dialogTitlebar(t, "child-preview-title")
      .track_focus(this.focus)
      .on_key_down((event, cx) => {
        if (!this.focus.is_focused() || event.key !== "escape" || Object.values(event.modifiers).some(Boolean)) return;
        cx.stop_propagation();
        closeOverlay(this.overlay);
      })
      .when(Boolean(icon), bar => bar.child(icon.flex_none()))
      .child(h_flex().min_w(0).flex_1().gap(8).items_center()
        .child(div().min_w(0).truncate().tooltip(title).child(title))
        .when(Boolean(STATUS[status]), bar => bar.child(div().flex_none().text_color(t[status] ?? t.dim).child(STATUS[status])))
        .when(Boolean(parent), bar => bar.child(div().min_w(0).truncate().text_color(t.dim).child(`from ${parent.name || parent.address}`))))
      .when(Boolean(hasPane || keep), bar => bar.child(dialogTitlebarButton(t, "keep", hasPane ? "↗ go to" : "↗ keep",
        hasPane ? "Go to terminal" : "Keep as a tab", () => this.openTerminal())))
      .child(dialogTitlebarButton(t, "close", "×", "Close preview (Esc)", () => closeOverlay(this.overlay)));
  }
}

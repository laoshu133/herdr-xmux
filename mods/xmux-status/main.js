import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, focused, theme, run, window, keys, nextCommand } from "herdr";
import { openTerminalTab, splitTerminal } from "./shared/context.js";
import { ReopenTab } from "./reopen.js";
import { QuickDialog } from "./quick-dialog.js";

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.reopenTab = new ReopenTab();
    this.reopenTab.init(cx);
    this.quickDialog = new QuickDialog();
    this.quickDialog.init();
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "new-terminal") openTerminalTab();
        else if (command.startsWith("split-right")) splitTerminal("right", command.split(":")[1]);
        else if (command.startsWith("split-down")) splitTerminal("down", command.split(":")[1]);
        else if (command === "cross-tab-next") this.crossTab(1);
        else if (command === "cross-tab-prev") this.crossTab(-1);
        else if (command === "reopen-closed") this.reopenTab.reopen();
        else if (command === "quick-dialog") cx.spawn(async () => this.quickDialog.toggle());
        else if (command === "close-current") this.quickDialog.closeCurrent();
      }
    });
  }

  crossTab(direction) {
    const ordered = [];
    for (const space of spaces()) {
      for (const tab of space.tabs ?? []) {
        if (!tab.settled) ordered.push({ space, tab });
      }
    }
    if (!ordered.length) return;

    const activeSpace = spaces().find((space) => space.active);
    const activeTab = activeSpace?.tabs?.find((tab) => tab.active);
    const focus = focused();
    const currentSpaceId = focus?.space ?? activeSpace?.id;
    const currentTabId = focus?.tab ?? activeTab?.id;
    let index = ordered.findIndex(
      ({ space, tab }) => space.id === currentSpaceId && tab.id === currentTabId,
    );
    if (index < 0) {
      index = ordered.findIndex(({ space, tab }) => space.active && tab.active);
    }
    if (index < 0) index = direction > 0 ? -1 : 0;
    const target = ordered[(index + direction + ordered.length) % ordered.length];
    if (!target) return;
    run("space.select", { id: target.space.id });
    run("tab.select", { id: target.tab.id });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(5).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(12)).child(text);
    return h_flex().size_full().px(12).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(div().id("palette").cursor_pointer().text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}

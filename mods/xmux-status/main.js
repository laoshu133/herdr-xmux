import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, terminals, focused, theme, run, shared, notify, window, keys, nextCommand } from "herdr";
import { activeWorkspace, openTerminalTab, splitTerminal } from "./shared/context.js";
import { ReopenTab } from "./reopen.js";
import { QuickDialog } from "./quick-dialog.js";
import { GitFooter } from "./git-footer.js";

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.reopenTab = new ReopenTab();
    this.reopenTab.init(cx);
    this.quickDialog = new QuickDialog();
    this.quickDialog.init();
    this.gitFooter = new GitFooter();
    this.gitFooter.refresh(cx);
    cx.timer.every(250, (cx) => this.gitFooter.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "new-terminal") openTerminalTab();
        else if (command.startsWith("split-right")) splitTerminal("right", command.split(":")[1]);
        else if (command.startsWith("split-down")) splitTerminal("down", command.split(":")[1]);
        else if (command === "cross-tab-next") this.navigate(1);
        else if (command === "cross-tab-prev") this.navigate(-1);
        else if (command === "focus-attention") this.focusAttention();
        else if (command === "reopen-closed") this.reopenTab.reopen();
        else if (command === "quick-dialog") cx.spawn(async () => this.quickDialog.toggle());
        else if (command === "close-current") this.quickDialog.closeCurrent();
      }
    });
  }

  navigate(direction) {
    if (shared("xmux-sidebar.navigation")?.tab === "agents")
      run(direction > 0 ? "agent.next" : "agent.prev");
    else this.crossTab(direction);
  }

  orderedAgents() {
    const byAddress = new Map(agents().map((agent) => [agent.address, agent]));
    const children = new Map();
    for (const terminal of terminals()) {
      if (terminal.state !== "live" || !terminal.parent || byAddress.has(terminal.address)) continue;
      const siblings = children.get(terminal.parent) ?? [];
      siblings.push(terminal);
      children.set(terminal.parent, siblings);
    }

    const published = shared("xmux-sidebar.navigation")?.order ?? [];
    const order = [...new Set([...published, ...byAddress.keys()])];
    const ordered = [];
    const seen = new Set();
    const append = (agent) => {
      if (seen.has(agent.address)) return;
      seen.add(agent.address);
      let status = agent.status;
      if (status === "error") status = "blocked";
      if (status === "done" && !byAddress.has(agent.address)) status = "idle";
      ordered.push({ address: agent.address, status });
      for (const child of children.get(agent.address) ?? []) append(child);
    };
    for (const address of order) {
      const agent = byAddress.get(address);
      if (agent) append(agent);
    }
    return ordered;
  }

  focusAttention() {
    const ordered = this.orderedAgents();
    const target = ordered.find((agent) => agent.status === "blocked")
      ?? ordered.find((agent) => agent.status === "done");
    if (target) run("agent.focus", { terminal: target.address });
    else notify({ title: "No agents need attention", level: "info" });
  }

  agentSummary(t) {
    const counts = { blocked: 0, done: 0, working: 0 };
    for (const agent of this.orderedAgents()) {
      if (Object.hasOwn(counts, agent.status)) counts[agent.status]++;
    }
    const visible = Object.entries(counts).filter(([, count]) => count > 0);
    if (!visible.length) return null;
    const labels = visible.map(([state, count]) => `${count} ${state}`).join(", ");
    const icons = {
      blocked: () => div().size(14).flex_none().rounded(4).bg(t.blocked + "26")
        .text_size(10.5).font_bold().text_color(t.blocked)
        .flex().items_center().justify_center().child("!"),
      done: () => div().size(7).mx(3).flex_none().rounded(4).bg(t.done),
      working: () => svg("mods/xmux-sidebar/icons/spinner.svg").size(12).mx(1).flex_none()
        .text_color(t.working),
    };
    return h_flex().id("agent-attention").gap(8).px(4).h_full().items_center().flex_none()
      .role("button")
      .accessibility_label(`Focus next Agent needing attention. ${labels}`)
      .tooltip(`${labels} · Focus next Agent needing attention`)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.focusAttention())
      .children(visible.map(([state, count]) => h_flex().gap(3).items_center()
        .child(icons[state]())
        .child(String(count))));
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

  render(cx) {
    const t = theme();
    const space = activeWorkspace({ remember: false });
    const label = (icon, text) => h_flex().gap(5).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(12)).child(text);
    const git = this.gitFooter.render(space, t, cx);
    const counts = this.agentSummary(t);
    return h_flex().size_full().px(12).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(git), el => el.child(git))
      .when(Boolean(counts), el => el.child(counts))
      .child(div().flex_1())
      .child(div().id("palette").cursor_pointer().text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}

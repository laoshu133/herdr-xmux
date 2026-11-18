// Spaces and agents in one block. Combined (the default): tabs for Spaces, with
// each space's tabs and agents under it, and Agents. With `combined: false` in the settings: the
// two lists one above the other, as two blocks of this mod would draw them.
import { v_flex, h_flex } from "gpui-base";
import { agents, focused, nextCommand, theme, setAgentOrder, setShared } from "herdr";
import { Spaces } from "./spaces.js";
import { Agents } from "./agents.js";
import { TEXT, Badge, IconButton, Rail } from "./ui.js";

const TABS = ["spaces", "agents"];

export class Lists {
  init(props, cx) {
    this.spaces = new Spaces();
    this.spaces.init(props, cx);
    this.agents = new Agents();
    this.agents.init(props, cx);
    const saved = localStorage.getItem("lists.tab");
    this.tab = TABS.includes(saved) ? saved : "spaces";
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "show-spaces") this.pick("spaces", cx);
        else if (command === "show-agents") this.pick("agents", cx);
      }
    });
  }

  pick(tab, cx) {
    this.tab = tab;
    localStorage.setItem("lists.tab", tab);
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const collapsed = this.spaces.collapsed();
    const root = v_flex()
      .id("xmux-sidebar-lists")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(TEXT.body)
      .on_mouse_move((event, cx) => this.agents.moveTabDrag(event, cx))
      .on_mouse_up("left", (_event, cx) => this.agents.commitTabDrag(cx))
      .on_mouse_down_out((_event, cx) => this.agents.cancelTabDrag(cx))
      .on_size_change((size, cx) => this.spaces.resized(size, cx));
    this.spaces.under = null;
    this.spaces.quiet = null;
    this.spaces.above = null;
    const view = this.agents.readView(cx);
    const navigation = {
      tab: this.spaces.settings.combined || collapsed ? this.tab : "spaces",
      order: view.list.map((agent) => agent.address),
    };
    const signature = JSON.stringify(navigation);
    if (signature !== this.navigationSignature) {
      this.navigationSignature = signature;
      cx.timer.after(0, () => {
        if (this.navigationSignature === signature) setShared("xmux-sidebar.navigation", navigation);
      });
    }
    if (collapsed) {
      root.child(v_flex().id("sidebar-rail-tabs").items_center().gap(4).py(4).flex_none()
        .border_b(1).border_color(t.border)
        .children([
          { id: "spaces", icon: "layers", label: "Spaces" },
          { id: "agents", icon: "agent", label: "Agents" },
        ].map(({ id, icon, label }) => IconButton({
          id: `rail-${id}`, icon, label, muted: this.tab !== id, onClick: (cx) => this.pick(id, cx),
        }).when(this.tab === id, (el) => el.bg(t.selected)))));
      if (this.tab === "agents") return root.child(this.agents.render(cx, { view, heading: false, expand: false }));
      return root.child(this.spaces.body(t, true));
    }

    if (!this.spaces.settings.combined)
      return root
        .child(
          v_flex()
            .flex_1()
            .min_h(0)
            .child(this.spaces.header(t, collapsed))
            .child(this.spaces.body(t, collapsed)),
        )
        .child(v_flex().flex_1().min_h(0).child(this.agents.render(cx, { view })));

    root.child(this.tabBar(t, view));
    if (this.tab !== "spaces") return root.child(this.agents.render(cx, { view, heading: false }));

    // Spaces, each with its tabs and agents beneath in tab order, so rows don't move as
    // their state changes; next-agent keys follow that order.
    const nested = { ...view, sort: { id: "grouped" }, byPriority: false, nested: true };
    const order = [];
    const all = agents();
    // Pinned agents go above every space, in the Agents tab's Pinned group.
    const pinned = view.groups.find((g) => g.id === "pinned");
    const pins = pinned?.members.map((a) => a.address) ?? [];
    order.push(...pins);
    this.spaces.above = () => (pinned ? this.agents.groupRows(pinned, view, t) : []);
    const nest = (lines, row) => h_flex().children(lines.map((l) => Rail(l))).child(row.flex_1().min_w(0));
    // A space's agents hang from its line; a main space's worktrees come after them,
    // so its line carries on, and a worktree's own agents sit one step further in.
    // Every tab shows: a tab with agents as its agents, any other as itself.
    const shownTab = focused()?.tab;
    const plain = (tab) => !all.some((a) => a.tab === tab.id);
    this.spaces.under = ({ w, tree, kids }) => {
      const items = w.tabs.flatMap((tab) =>
        plain(tab)
          ? tab.settled ? [] : [{ tab }]
          : all.filter((a) => a.tab === tab.id && !pins.includes(a.address)).map((a) => ({ a })),
      );
      order.push(...items.filter((x) => x.a).map((x) => x.a.address));
      const before = tree ? [tree.startsWith("└") ? "" : "│"] : [];
      return items.flatMap((x, i) => {
        const last = i === items.length - 1 && !kids;
        const [row, ...subs] = x.a
          ? this.agents.agentWithSubs(x.a, nested, t)
          : [this.agents.tabRow(w, x.tab, x.tab.id === shownTab, t)];
        return [nest([...before, last ? "└" : "├"], row), ...subs.map((s) => nest([...before, last ? "" : "│"], s))];
      });
    };
    // One row lit: a space whose focused agent or tab shows beneath it leaves it to that row.
    this.spaces.quiet = (w) =>
      all.some((a) => a.space === w.id && a.focused) || w.tabs.some((tab) => tab.id === shownTab && plain(tab));
    const body = this.spaces.body(t, false);
    setAgentOrder(order);
    return root.child(body);
  }

  // Tabs side by side from the left, the picked one filled.
  tabBar(t, view) {
    const tab = (id, label, count) =>
      h_flex()
        .id(`lists-tab-${id}`)
        .px(8)
        .h(30)
        .gap(9)
        .justify_center()
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .text_size(TEXT.label)
        .font_medium()
        .text_color(this.tab === id ? t.foreground : t.dim)
        .when(this.tab === id, (el) => el.bg(t.selected))
        .when(this.tab !== id, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click((_e, cx) => this.pick(id, cx))
        .child(label)
        // The count badge the group headers use.
        .when(count !== null, (el) => el.child(Badge(count)));
    return h_flex()
      .px(8)
      .pt(6)
      .pb(6)
      .mb(4)
      .border_b(1)
      .border_color(t.border)
      .flex_none()
      .gap(6)
      .items_center()
      .child(
        h_flex()
          .flex_1()
          .gap(2)
          .child(tab("spaces", "Spaces", null))
          .child(tab("agents", "Agents", view.count)),
      )
      .child(this.tab === "spaces" ? this.spaces.newSpaceButton() : this.agents.sortMenu());
  }
}

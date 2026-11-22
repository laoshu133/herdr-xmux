// One horizontally scrolling tab strip, the + after it, then the toolbar and ⋮.
import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, run, openOverlay, setShared, theme, window, shared, layout, settings } from "herdr";
import { openTerminalTab } from "../shared/context.js";
import { TEXT, Icon, IconButton, DropLine } from "./ui.js";
import { automaticTabTitle, tabLead } from "../shared/tab-title.js";

const CHAR_WIDTH = 8; // Roughly, to size the drag preview.
const TAB_HEIGHT = 36;
const TAB_GAP = 0;
const CLOSE_BUTTON_WIDTH = 18;
const NEW_TAB_GAP = 6;
const TOOLBAR_GAP = 4;
const BAR_HEIGHT = TAB_HEIGHT;
const BAR_PADDING = 0;

// Native buttons stay in window coordinates while XMux sizes follow UI zoom.
export function tabBarInset(root, w, zoom = 1) {
  if (w?.platform !== "macos" || w.titlebar !== "none" || w.fullscreen || !root?.traffic_lights) return 0;
  const sidebar = root.children?.find((node) => node.id === "sidebar");
  const width = sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0;
  return Math.max(0, (root.traffic_lights[0] + 64) / zoom - width);
}

const contains = (bounds, point) =>
  bounds &&
  point.x >= bounds.x &&
  point.x <= bounds.x + bounds.width &&
  point.y >= bounds.y &&
  point.y <= bounds.y + bounds.height;


function openNewMenu(space) {
  openOverlay({
    mod: "xmux-new-menu",
    kind: "popup",
    width: 250,
    height: 512,
    props: { space: space?.id },
  });
}

export const tabBarMethods = {
  openNewMenu() {
    openNewMenu(spaces().find((space) => space.active));
  },

  // A small button that ignores the click a drag's release can leave behind.
  simple(id, content, label, action) {
    return IconButton({
      id,
      content,
      label,
      onClick: (event, cx) => {
        if (!(Date.now() < this.ignoreClickUntil)) action(event, cx);
      },
    });
  },

  tabIcon(tab, ps, t) {
    const mine = ps.filter((p) => p.tab === tab.id);
    const program = (mine.find((p) => p.program?.agent) ?? mine[0])?.program;
    if (program?.icon) {
      return program.tint
        ? svg(program.icon).size(14).text_color(t.muted)
        : image(program.icon).size(14);
    }
    // Mod panes carry no program, but a mod may publish an icon for itself.
    const modIcon = shared("mod-icons")?.[mine.find((p) => p.mod)?.mod];
    return modIcon ? svg(modIcon).size(14).text_color(t.muted) : null;
  },

  tabItem(tab, space, ps, t) {
    const icon = this.tabIcon(tab, ps, t);
    const drag = this.tabDrag;
    const lead = tabLead(tab, ps, focused());
    const label = automaticTabTitle(tab, lead, shared("pane-heads")?.[lead?.pane]?.title);
    const showClose = tab.active || this.hoveredTab === tab.id;
    return h_flex()
      .id(`tab-${tab.id}`)
      .relative()
      .h(TAB_HEIGHT)
      .pl(10)
      .pr(4)
      .gap(4)
      .rounded(0)
      .items_center()
      .flex_none()
      .max_w(this.settings.tabs.max_width)
      .text_size(TEXT.tab)
      .bg(tab.active ? t.background : t.chrome)
      .text_color(tab.active ? t.foreground : t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).border_color(tab.active ? t.accent : t.input))
      .on_hover((hovered, cx) => {
        if (hovered === (this.hoveredTab === tab.id)) return;
        this.hoveredTab = hovered ? tab.id : null;
        cx.notify();
      })
      .when(drag?.active && drag.id === tab.id, (el) => el.opacity(0.35))
      .on_mouse_down("left", (event, cx) => this.beginTabDrag(tab, event, cx))
      .on_mouse_move((event, cx) => this.hoverTab(tab, event, cx))
      .on_mouse_up("left", (event, cx) => this.finishTabDrag(tab, event, cx))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.cancelDrags(cx);
        openOverlay({
          mod: "menu",
          kind: "popup",
          width: 200,
          props: { tab: "tab", target: { id: tab.id, space: space.id } },
        });
      })
      .when(Boolean(icon), (el) => el.child(icon))
      .child(
        div()
          .flex_auto()
          .min_w(0)
          .truncate()
          .tooltip(label)
          .child(tab.zoomed ? `${label} Z` : label),
      )
      .when(tab.status === "working", (el) =>
        el.child(Icon("spinner", 12).text_color(t.working).spin(900)),
      )
      .when(["blocked", "done"].includes(tab.status), (el) =>
        el.child(div().size(6).rounded(3).bg(t[tab.status])),
      )
      // Reserve the same space so showing the button never shifts adjacent tabs.
      .child((showClose ? this.closeTabButton(tab) : div().flex_none())
        .w(CLOSE_BUTTON_WIDTH)
        .h(22))
      .when(drag?.active && drag.target?.id === tab.id, (el) =>
        el.child(DropLine(drag.target.after)),
      )
      // Draw the rule as a child so it is painted over the strip's neutral
      // baseline.  Keeping it inside the fixed-height tab also prevents the
      // inactive rule from disappearing when the parent baseline is present.
      .child(
        div()
          .absolute()
          .left(0)
          .right(0)
          .bottom(0)
          .h(1)
          .bg(tab.active ? t.accent : t.border),
      );
  },

  closeTabButton(tab) {
    return this.simple(`close-${tab.id}`, Icon("close", 12), "Close tab", (_e, cx) => {
      this.cancelDrags(cx);
      run("tab.close", { id: tab.id });
    }).on_mouse_up("left", (_e, cx) => cx.stop_propagation());
  },

  dragPreview(t) {
    const drag = this.tabDrag?.active ? this.tabDrag : this.actionDrag();
    if (!drag?.active) return null;
    const width = Math.min(
      200,
      Math.max(90, String(drag.label).length * CHAR_WIDTH + (drag.icon ? 52 : 32)),
    );
    const x = drag.point.x - (this.barBounds?.x ?? 0);
    // Offset the preview from the pointer so it cannot cover the drop hitbox.
    const left = x + width + 12 < (this.width ?? 1200) ? x + 12 : Math.max(0, x - width - 12);
    return h_flex()
      .id("drag-preview")
      .absolute()
      .left(left)
      .top(4)
      .h(29)
      .w(width)
      .px(9)
      .gap(5)
      .items_center()
      .rounded(0)
      .border(1)
      .border_color(t.accent)
      .bg(t.raised)
      .text_color(t.foreground)
      .opacity(0.95)
      .when(Boolean(drag.icon), (el) => el.child(Icon(drag.icon)))
      .child(div().min_w(0).truncate().child(drag.label));
  },

  render() {
    if (this.config().mode === "overflow") return this.renderOverflow();
    const t = theme();
    const bar = h_flex()
      .id("xmux-tabs-root")
      .relative()
      .text_size(TEXT.tab)
      .size_full()
      .h(BAR_HEIGHT)
      .min_h(BAR_HEIGHT)
      .max_h(BAR_HEIGHT)
      .min_w(0)
      .pl(tabBarInset(layout(), window(), settings().zoom))
      .pr(10)
      .pt(BAR_PADDING / 2)
      .gap(TAB_GAP)
      .items_start()
      .bg(t.chrome)
      // Keep the container rule independent from tab item borders.  A parent
      // border is painted after its children in GPUI, which hid the active
      // tab's accent line at the shared bottom pixel.  Painting the neutral
      // rule as the first child lets later tab items sit on top of it while
      // keeping one continuous 1px line across the toolbar.
      .child(div().absolute().left(0).right(0).bottom(0).h(1).bg(t.border))
      .on_size_change((size, cx) => {
        if (this.width !== size.width) {
          this.width = size.width;
          cx.notify();
        }
      })
      .on_mouse_move((event, cx) => this.movePointer(event, cx))
      .on_mouse_up("left", (_event, cx) => {
        this.commitTabDrag(cx);
        this.finishActionDrag(cx);
      })
      .on_mouse_down_out((_event, cx) => this.cancelDrags(cx))
      .on_hover((hovered, cx) => {
        if (!hovered) this.cancelDrags(cx);
      })
      .child(this.renderTabList(t))
      .child(this.renderToolbar(t));
    if (window()?.buttons) bar.children(this.windowButtons());
    const preview = this.dragPreview(t);
    if (preview) bar.child(preview);
    return bar;
  },

  renderTabList(t) {
    const space = spaces().find((s) => s.active);
    const tabs = space?.tabs ?? [];
    const ps = panes();
    const active = tabs.findIndex((tab) => tab.active);
    const pending = shared("xmux.pending-append");
    const created =
      pending?.space === space?.id && tabs.find((tab) => !pending.existing.includes(tab.id));
    if (created) {
      run("tab.move", { id: created.id, index: pending.index });
      setShared("xmux.pending-append", null);
    }
    if (active >= 0 && active !== this.revealedTab) {
      this.tabScroll?.scroll_to_item(active);
      this.revealedTab = active;
    }
    return h_flex()
      .id("tab-scroll")
      .flex_1()
      .min_w(0)
      .items_center()
      .gap(TAB_GAP)
      .overflow_x_scroll()
      .track_scroll(this.tabScroll)
      .children(tabs.map((tab) => this.tabItem(tab, space, ps, t)))
      .child(this.newTabButton(tabs));
  },

  // Dropping a tab on the + puts it last.
  newTabButton(tabs) {
    const asLast = (event) => ({ ...event, local_position: { x: Infinity } });
    return this.simple("tab-new", Icon("plus", 14), "New terminal · Shift-click for more", (event) => {
      const space = spaces().find((s) => s.active);
      if (event.modifiers?.shift) openNewMenu(space);
      else openTerminalTab(space, {}, focused());
    })
      .when(tabs.length > 0, (el) => el.ml(NEW_TAB_GAP))
      .on_mouse_move((event, cx) => {
        if (tabs.length) this.hoverTab(tabs.at(-1), asLast(event), cx);
      })
      .on_mouse_up("left", (event, cx) => {
        if (this.tabDrag && tabs.length) this.finishTabDrag(tabs.at(-1), asLast(event), cx);
      });
  },

  renderToolbar(t) {
    const { visible, overflow } = this.toolbar();
    const toolbar = h_flex()
      .id("action-toolbar")
      .h(TAB_HEIGHT)
      .gap(TOOLBAR_GAP)
      .items_center()
      .flex_none()
      .on_mouse_move((event, cx) => {
        const drag = this.actionDrag();
        if (!drag || contains(drag.target?.bounds, event.position ?? drag.point)) return;
        this.moveActionDrag(event, cx, {
          kind: "toolbar",
          id: visible.at(-1)?.id ?? null,
          after: true,
          bounds: event.bounds,
        });
      })
      .on_hover((hovered, cx) => {
        if (!hovered && this.actionDrag()?.target) this.moveActionDrag({}, cx, null);
      });
    let group;
    for (const entry of visible) {
      if (group !== undefined && entry.group !== group)
        toolbar.child(div().w(1).h(16).mx(4).bg(t.border));
      group = entry.group;
      toolbar.child(this.actionButton(entry));
    }
    return toolbar.child(this.moreButton(overflow, t));
  },

  // The ⋮: lists hidden actions, and takes a dragged action to hide it.
  moreButton(overflow, t) {
    const drag = this.actionDrag();
    return this.simple(
      "actions-more",
      Icon("more-vertical", 16),
      "More actions · drop a toolbar action here to hide it",
      () => this.openActions(overflow),
    )
      .when(drag?.active && drag.target?.kind === "overflow", (el) =>
        el.bg(t.selected).border(1).border_color(t.accent),
      )
      .on_mouse_down("left", (event, cx) => {
        cx.stop_propagation();
        this.moreBounds = event.bounds ?? this.moreBounds;
      })
      .on_mouse_move((event, cx) => {
        this.moreBounds = event.bounds ?? this.moreBounds;
        this.moveActionDrag(event, cx, { kind: "overflow", bounds: event.bounds });
      })
      .on_mouse_up("left", (_event, cx) => {
        cx.stop_propagation();
        this.finishActionDrag(cx);
      });
  },

  // Windows and Linux draw their own window controls.
  windowButtons() {
    const w = window();
    const windows = w.platform === "windows";
    return [
      this.simple("minimize", windows ? Icon("win-min", 16) : "−", "Minimize", () =>
        run("window.minimize"),
      ),
      this.simple(
        "maximize",
        windows ? Icon(w.maximized ? "win-restore" : "win-max", 16) : "□",
        "Maximize",
        () => run("window.maximize"),
      ),
      this.simple("close-window", Icon("close", 13), "Close window", () => run("window.close")),
    ];
  },
};

import { View, div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, window, shared, setShared, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", {
    id: "sidebar",
    px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44,
  });
}

export default class XmuxWorkspaceChrome extends View {
  button(id, label, action, t) {
    return div()
      .id(id)
      .size(26)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_click(action)
      .accessibility_label(label);
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    return h_flex()
      .size_full()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .pl(collapsed ? 6 : 14)
      .pr(10)
      .gap(4)
      .items_center()
      .text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, (el) => el.pl(76))
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .flex_1()
            .gap(8)
            .items_center()
            .child(image("frame/welcome/herdr.png").size(20).rounded(5))
            .child(div().font_semibold().text_color(t.foreground).child("Herdr")),
        ),
      )
      .when(!collapsed, (el) =>
        el.child(
          this.button("search", "Search", () => run("mod.open", { name: "picker" }), t).child(
            svg("mods/xmux-workspace-chrome/search.svg").size(15),
          ),
        ),
      )
      .when(!(collapsed && window()?.platform === "macos"), (el) =>
        el.child(
          this.button("sidebar-toggle", "Toggle sidebar", toggleSidebar, t).child(
            svg("mods/xmux-workspace-chrome/sidebar.svg").size(15),
          ),
        ),
      );
  }
}

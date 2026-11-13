import { View } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, theme } from "herdr";

// The layout schema only supports an all-side focused border. This one-pixel
// header keeps the pane geometry stable and marks focus on its top edge only.
export default class PaneFocusLine extends View {
  render() {
    const current = panes().find((pane) => pane.pane === props()?.pane);
    const t = theme();
    return h_flex()
      .id(`xmux-pane-focus-${props()?.pane ?? "unknown"}`)
      .h(1)
      .w_full()
      .flex_none()
      .bg(current?.focused ? t.accent : t.background);
  }
}

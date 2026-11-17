import { openOverlay } from "herdr";
import { openTerminalTab } from "../shared/context.js";

// tab.new returns no id; the tabs mod recognizes the new entry on its next render.
export function newTerminalClick(space, current, event) {
  if (event?.modifiers?.shift) {
    openOverlay({
      mod: "xmux-new-menu",
      kind: "popup",
      width: 250,
      height: 512,
      props: { space: space?.id },
    });
    return;
  }
  openTerminalTab(space, {}, current);
}

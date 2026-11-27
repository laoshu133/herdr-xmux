// XMux Sidebar: window chrome, spaces, agents, a footer and a right panel
// toggle. A layout puts one copy per block, and `view` picks which part.
import { View } from "gpui-kit";
import { props } from "herdr";
import { Spaces } from "./views/spaces.js";
import { Agents } from "./views/agents.js";
import { Lists } from "./views/lists.js";
import { Footer } from "./views/footer.js";
import { PanelToggle } from "./views/panel-toggle.js";
import { Chrome } from "./views/chrome.js";
import { ChildPreview } from "./views/child-preview.js";

const PARTS = {
  chrome: Chrome, lists: Lists, agents: Agents, footer: Footer, "panel-toggle": PanelToggle,
  "child-preview": ChildPreview,
};

export default class XmuxSidebar extends View {
  init(given, cx) {
    const Part = PARTS[props()?.view] ?? Spaces;
    this.part = new Part();
    this.part.init?.(given, cx);
  }

  render(cx) {
    return this.part.render(cx);
  }

  close(cx) {
    return this.part?.close?.(cx);
  }
}

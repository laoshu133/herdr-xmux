import { Scrollbar } from "gpui-base";

// Keep every XMux list on Herdr's built-in scrollbar implementation. Its
// `scrolling` mode fades the thumb in during scroll and out after idle.
export function scrollingScrollbar(id) {
  return Scrollbar.vertical(id).mode("scrolling").absolute().inset_0();
}

import { closeOverlay, openOverlay, setShared } from "herdr";
import { DIALOG_TITLEBAR_GRIP, DIALOG_TITLEBAR_HEIGHT } from "./dialog-titlebar.js";

// Mod copies have separate sessionStorage. The window's JS runtime is shared.
const KEY = Symbol.for("xmux.child-preview");
const TITLE_FOCUS = "xmux.child-preview.title-focus";

export function rememberChildPreview(overlay, terminal) {
  if (globalThis[KEY]?.overlay !== overlay) globalThis[KEY] = { overlay, terminal, titleFocused: false };
}

export function forgetChildPreview(overlay) {
  if (globalThis[KEY]?.overlay !== overlay) return;
  delete globalThis[KEY];
  setShared(TITLE_FOCUS, null);
}

export function updateChildPreviewTitleFocus(overlay, focused) {
  const preview = globalThis[KEY];
  if (preview?.overlay !== overlay || preview.titleFocused === focused) return;
  preview.titleFocused = focused;
  // Wake the sidebar. The actual focus state belongs to this window's runtime.
  setShared(TITLE_FOCUS, focused ? overlay : null);
}

export function focusedChildPreview(focus) {
  const preview = globalThis[KEY];
  if (!preview) return null;
  const terminalFocused = focus?.pane === null && focus.terminal === preview.terminal;
  return preview.titleFocused || terminalFocused ? preview.terminal : null;
}

export function dismissChildPreview() {
  const overlay = globalThis[KEY]?.overlay;
  if (!overlay) return false;
  closeOverlay(overlay);
  return true;
}

export function openChildPreview(terminal) {
  dismissChildPreview();
  const overlay = openOverlay({
    kind: "window",
    width: 0.8,
    height: 0.8,
    layout: {
      type: "column",
      gap: 0,
      children: [
        { type: "row", size: { px: DIALOG_TITLEBAR_GRIP }, background: "chrome", children: [] },
        { type: "block", size: { px: DIALOG_TITLEBAR_HEIGHT - DIALOG_TITLEBAR_GRIP }, content: { mod: "xmux-sidebar", props: { view: "child-preview", terminal } } },
        { type: "block", content: { terminal } },
      ],
    },
  });
  rememberChildPreview(overlay, terminal);
}

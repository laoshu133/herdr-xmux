// Generated from lib/xmux/child-preview.js. Run node scripts/sync-common.mjs.
import { closeOverlay, openOverlay } from "herdr";

// Mod copies have separate sessionStorage. The window's JS runtime is shared.
const KEY = Symbol.for("xmux.child-preview");

export function rememberChildPreview(overlay) {
  globalThis[KEY] = overlay;
}

export function forgetChildPreview(overlay) {
  if (globalThis[KEY] === overlay) delete globalThis[KEY];
}

export function dismissChildPreview() {
  const overlay = globalThis[KEY];
  if (!overlay) return false;
  closeOverlay(overlay);
  return true;
}

export function openChildPreview(terminal) {
  dismissChildPreview();
  const overlay = openOverlay({
    kind: "dialog",
    modal: false,
    width: 0.8,
    height: 0.8,
    layout: {
      type: "column",
      children: [
        { type: "block", size: { px: 34 }, content: { mod: "peek", props: { terminal } } },
        { type: "block", content: { terminal } },
        // This block follows the overlay's lifetime, even when the titlebar
        // takes keyboard focus or the user clicks the backdrop.
        { type: "block", size: { px: 0 }, content: { mod: "xmux-sidebar", props: { view: "child-preview" } } },
      ],
    },
  });
  rememberChildPreview(overlay);
}

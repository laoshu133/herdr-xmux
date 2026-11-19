// Generated from lib/xmux/file-menu.js. Run node scripts/sync-common.mjs.
import { openOverlay, spaces } from "herdr";

// A plain-data contract: each entry point opens the same Files menu instance.
export function fileMenuTarget(file, options = {}) {
  const top = options.top ?? file.root;
  const prefix = top?.replace(/\/$/, "") + "/";
  return {
    path: file.path, root: file.root, on: file.on ?? null,
    space: options.space ?? spaces().find((s) => s.active)?.id,
    top, dir: Boolean(options.dir),
    relative: top && file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path.split("/").pop(),
    changed: Boolean(options.changed), staged: Boolean(options.staged),
  };
}

export function showFileMenu(target) {
  openOverlay({ mod: "xmux-files", kind: "popup", width: 260, height: 520,
    props: { mode: "menu", target } });
}

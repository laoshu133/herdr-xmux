import { openOverlay, panes, run, setShared } from "herdr";

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
  const mine = space?.tabs ?? [];
  const active = mine.find((tab) => tab.active);
  const existing = new Set(mine.map((tab) => tab.id));
  const cwd =
    current?.tab === active?.id && current?.cwd
      ? current.cwd
      : active
        ? panes().find((p) => p.tab === active.id && p.cwd)?.cwd
        : undefined;
  run("tab.new", { space: space?.id, folder: cwd });
  setShared("xmux.pending-append", {
    space: space?.id,
    existing: [...existing],
    index: mine.length + 1,
  });
}

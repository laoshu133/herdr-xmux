import { notify, panes, run, setShared, shared, spaces } from "herdr";

const CLOSED = "xmux.closed-tab";

function snapshots() {
  const current = new Map();
  const ps = panes();
  for (const space of spaces()) {
    for (const tab of space.tabs ?? []) {
      const own = ps.filter((pane) => pane.tab === tab.id && pane.cwd);
      const cwd = (own.find((pane) => pane.focused) ?? own[0])?.cwd;
      if (cwd) current.set(tab.id, { space, tab, cwd });
    }
  }
  return current;
}

export class ReopenTab {
  init(cx) {
    this.tabs = snapshots();
    cx.timer.every(300, () => this.rememberClosed());
  }

  rememberClosed() {
    const current = snapshots();
    for (const [id, snapshot] of this.tabs) {
      if (!current.has(id)) setShared(CLOSED, { ...snapshot, closedAt: Date.now() });
    }
    this.tabs = current;
  }

  reopen() {
    const closed = shared(CLOSED);
    if (!closed?.cwd) {
      notify({ title: "XMux", body: "No recently closed tab with a working directory.", level: "info" });
      return;
    }
    const { space, tab, cwd } = closed;
    const name = tab.named ? tab.name : undefined;
    if (spaces().some((entry) => entry.id === space.id)) {
      const existing = new Set((spaces().find((entry) => entry.id === space.id)?.tabs ?? []).map((entry) => entry.id));
      run("tab.new", { space: space.id, name, folder: cwd });
      const created = spaces().find((entry) => entry.id === space.id)?.tabs.find((entry) => !existing.has(entry.id));
      if (created) run("tab.move", { id: created.id, index: tab.index });
    } else {
      run("space.new", {
        name: space.named ? space.name : undefined,
        machine: space.machine,
        folder: cwd,
        tab: name,
      });
    }
    setShared(CLOSED, null);
  }
}

// Opening a file in the centre. Every viewer has an ID in a shared registry,
// because a copy of a mod can't name its own tab: it records the tab it was
// opened in, and the sidebar and menus act through that.
import { panes, run, shared, setShared, spaces } from "herdr";
import { baseName } from "../files/model.js";

const VIEWERS = "xmux-files.viewers";
const OPENING_MS = 1500;
const PRUNE_AFTER_MS = 15000;

export const viewerEntries = () => shared(VIEWERS) ?? {};

export const openMethods = {
  setViewer(id, change) {
    const entries = viewerEntries();
    setShared(VIEWERS, { ...entries, [id]: { ...entries[id], ...change } });
  },

  tabIsLive(tab) {
    return panes().some((p) => p.tab === tab && p.mod === "xmux-files");
  },

  viewerIsLive(entry) {
    return entry.tab ? this.tabIsLive(entry.tab) : Date.now() - (entry.at ?? 0) < OPENING_MS;
  },

  liveViewers(space) {
    return Object.entries(viewerEntries()).filter(
      ([, entry]) => entry.space === space && this.viewerIsLive(entry),
    );
  },

  // Tabs that have closed take their entries with them. Not at first: after a restart the
  // tabs come back a moment after this runs, and would lose their place in the registry,
  // so a click would open a file again that's already open.
  pruneViewers() {
    if (Date.now() - this.startedAt < PRUNE_AFTER_MS) return;
    const entries = viewerEntries();
    const live = Object.entries(entries).filter(([, entry]) => this.viewerIsLive(entry));
    if (live.length !== Object.keys(entries).length) setShared(VIEWERS, Object.fromEntries(live));
  },

  newViewer(file, space) {
    const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    // Tabs that aren't this one, so it can tell its own when it opens.
    const others = panes()
      .filter((p) => p.mod === "xmux-files")
      .map((p) => p.tab);
    this.setViewer(id, { space, file, tab: null, others, at: Date.now() });
    run("tab.new", {
      space,
      name: baseName(file.path),
      mod: "xmux-files",
      props: { mode: "viewer", viewer: id, space, file },
    });
    return id;
  },

  // A click: select the file's existing tab, otherwise open a new one.
  openFile(file, cx) {
    const space = spaces().find((s) => s.active)?.id;
    if (!space) return;
    const viewers = this.liveViewers(space);
    const open = viewers.find(([, entry]) => entry.file?.path === file.path);
    if (open) {
      if (open[1].tab) run("tab.select", { id: open[1].tab });
    } else this.newViewer(file, space);
    cx?.notify();
  },

  // From the menu: always a tab of its own.
  openInNewTab(file, cx) {
    const space = spaces().find((s) => s.active)?.id;
    if (!space) return;
    const open = this.liveViewers(space).find(([, entry]) => entry.file?.path === file.path);
    if (open) {
      if (open[1].tab) run("tab.select", { id: open[1].tab });
    } else this.newViewer(file, space);
    cx?.notify();
  },

  // Hands a changed file to XMux Changes, the way its own list does. `top` is the Git
  // root, which is what it knows a file by.
  showDiff(target, cx) {
    const space = spaces().find((s) => s.active);
    if (!space || !target.top) return;
    const source = { cwd: target.top, on: target.on ?? null };
    const selection = {
      context: JSON.stringify(source),
      root: target.top,
      on: target.on ?? null,
      path: target.path.slice(target.top.length + 1),
      scope: target.staged ? "staged" : "unstaged",
      at: Date.now(),
    };
    const entries = shared("xmux-changes.diff-tabs") ?? {};
    const ids = new Set((space.tabs ?? []).map((t) => t.id));
    const tab = panes().find((p) => p.mod === "xmux-changes" && ids.has(p.tab))?.tab;
    const name = baseName(target.path);
    setShared("xmux-changes.selection", selection);
    setShared("xmux-changes.diff-tabs", {
      ...entries,
      [space.id]: { source, selection, pending: tab ? null : Date.now() },
    });
    if (tab) {
      run("tab.rename", { id: tab, name });
      run("tab.select", { id: tab });
    } else
      run("tab.new", {
        space: space.id,
        name,
        mod: "xmux-changes",
        props: { mode: "diff", space: space.id, source, selection },
      });
    cx?.notify();
  },
};

// Opening a file in the centre. Viewers share their tab IDs with the sidebar.
import { panes, run, shared, setShared, spaces } from "herdr";
import { baseName } from "../files/model.js";

const VIEWERS = "xmux-files.viewers";
const OPENING_MS = 1500;
const PRUNE_AFTER_MS = 15000;

export const viewerEntries = () => shared(VIEWERS) ?? {};

const pendingTabName = (id, file) => `${baseName(file.path).trim()} · ${id}`;

// Core syncs mod props verbatim between clients. A space seen as `m5/id` on
// another computer is just `id` here; paths belong to that space's machine.
export function restoreViewerSource(entry, list = spaces()) {
  const bare = (id) => id?.split("/").pop();
  const exact = list.find((s) => s.id === entry.space);
  const matches = list.filter((s) => bare(s.id) === bare(entry.space));
  const owner = exact ?? (matches.length === 1 ? matches[0] : null);
  if (!owner || !entry.file) return entry;
  const tab = owner.tabs?.find((t) => bare(t.id) === bare(entry.tab));
  return { ...entry, space: owner.id, tab: tab?.id ?? entry.tab,
    file: { ...entry.file, on: owner.machine ?? null } };
}

export const openMethods = {
  setViewer(id, change) {
    const entries = viewerEntries();
    setShared(VIEWERS, { ...entries, [id]: { ...entries[id], ...change } });
  },

  findViewerTab(id, entry, spaceList = spaces(), paneList = panes()) {
    if (!entry.file) return null;
    const space = spaceList.find((s) => s.id === entry.space);
    const modTabs = new Set(paneList.filter((p) => p.mod === "xmux-files").map((p) => p.tab));
    const tabs = (space?.tabs ?? []).filter((tab) => modTabs.has(tab.id));
    const pending = tabs.find((tab) => tab.name === pendingTabName(id, entry.file));
    if (pending) return pending;
    const saved = tabs.find((tab) => tab.id === entry.tab);
    if (entry.bound || entry.pending) return saved ?? null;

    // Earlier versions inferred ownership from focus, which could point to the
    // previous tab. Repair old bindings where the file name identifies one tab.
    const name = baseName(entry.file.path).trim();
    if (saved?.name === name) return saved;
    const claimed = new Set(Object.entries(viewerEntries())
      .filter(([otherId, other]) => otherId !== id && other.space === entry.space &&
        (other.bound || (other.file && baseName(other.file.path).trim() === name)))
      .map(([, other]) => other.tab));
    const matches = tabs.filter((tab) => tab.name === name && !claimed.has(tab.id));
    return matches.length === 1 ? matches[0] : saved ?? null;
  },

  bindViewerTab(id, entry) {
    const tab = this.findViewerTab(id, entry);
    if (!tab) return null;
    const pending = tab.name === pendingTabName(id, entry.file);
    if (pending || tab.id !== entry.tab) {
      this.setViewer(id, { tab: tab.id, bound: pending || entry.bound, pending: false });
    }
    if (pending) run("tab.rename", { id: tab.id, name: baseName(entry.file.path) });
    return tab.id;
  },

  viewerIsOpening(entry) {
    return !entry.tab && Date.now() - (entry.at ?? 0) < OPENING_MS;
  },

  // Tabs that have closed take their entries with them. Not at first: after a restart the
  // tabs come back a moment after this runs, and would lose their place in the registry,
  // so a click would open a file again that's already open.
  pruneViewers() {
    if (Date.now() - this.startedAt < PRUNE_AFTER_MS) return;
    const entries = viewerEntries();
    const spaceList = spaces();
    const paneList = panes();
    const live = Object.entries(entries).filter(([id, entry]) =>
      this.viewerIsOpening(entry) || this.findViewerTab(id, entry, spaceList, paneList));
    if (live.length !== Object.keys(entries).length) setShared(VIEWERS, Object.fromEntries(live));
  },

  newViewer(file, space) {
    const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    // run() queues the command without returning the new tab ID. Use a unique
    // name until the tab appears in spaces(), then restore the file name.
    this.setViewer(id, { space, file, tab: null, pending: true, at: Date.now() });
    run("tab.new", {
      space,
      name: pendingTabName(id, file),
      mod: "xmux-files",
      props: { mode: "viewer", viewer: id, space, file },
    });
    return id;
  },

  // A click: select the file's existing tab, otherwise open a new one.
  openFile(file, cx) {
    const space = file.space ?? spaces().find((s) => s.active)?.id;
    if (!space) return;
    const entries = Object.entries(viewerEntries()).filter(([, entry]) =>
      entry.space === space && entry.file?.path === file.path &&
      (entry.file?.on ?? null) === (file.on ?? null));
    for (const [id, entry] of entries) {
      const tab = this.bindViewerTab(id, entry);
      if (!tab && !this.viewerIsOpening(entry)) continue;
      if (tab) run("tab.select", { id: tab });
      cx?.notify();
      return;
    }
    this.newViewer(file, space);
    cx?.notify();
  },

  // Hands a changed file to XMux Changes, the way its own list does. `top` is the Git
  // root, which is what it knows a file by.
  showDiff(target, cx) {
    const space = target.space ? spaces().find((s) => s.id === target.space) : spaces().find((s) => s.active);
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

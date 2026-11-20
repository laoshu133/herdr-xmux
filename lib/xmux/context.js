import { spaces, panes, focused, shared, setShared, run } from "herdr";

const WORKSPACES = "xmux.workspace-contexts";
const ROOTS = "xmux.repository-roots";
const machine = (on) => on ?? null;

export function knownRoot(cwd, on) {
  if (!cwd) return cwd;
  const roots = shared(ROOTS) ?? [];
  const exact = roots.find((r) => r.on === machine(on) && r.cwd === cwd);
  if (exact) return exact.root;
  return cwd;
}

export function rememberRoot(cwd, root, on) {
  const entry = { cwd, root, on: machine(on) };
  const old = shared(ROOTS) ?? [];
  if (old.some((r) => r.cwd === cwd && r.root === root && r.on === entry.on)) return;
  setShared(ROOTS, [...old.filter((r) => !(r.cwd === cwd && r.on === entry.on)), entry].slice(-64));
}

function ownPanes(space, ps) {
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  return ps.filter((p) => tabs.has(p.tab) && !p.mod && p.cwd);
}

// Mod panes have no cwd. Resolve their explicit source before any remembered
// terminal (which may be the home directory, or may already have closed).
function previewDirectory(space, ps) {
  const tab = space.tabs?.find((t) => t.active)?.id;
  const mods = ps.filter((p) => p.tab === tab).map((p) => p.mod);
  if (mods.includes("xmux-files")) {
    const entry = Object.values(shared("xmux-files.viewers") ?? {}).find((v) =>
      v.space === space.id && v.tab === tab && machine(v.file?.on) === machine(space.machine));
    if (entry?.file?.root) return entry.file.root;
  }
  if (mods.includes("xmux-changes")) {
    const source = shared("xmux-changes.diff-tabs")?.[space.id]?.source;
    if (source && machine(source.on) === machine(space.machine)) return source.cwd;
  }
}

// Same checkout definition as the sidebar. A remote space's persisted folder
// can be empty even after its main terminal has moved into a project.
export function spaceDirectory(space, ps = panes()) {
  if (!space) return undefined;
  const first = ownPanes(space, ps)[0];
  const saved = shared(WORKSPACES)?.[space.id];
  return (first?.cwd && knownRoot(first.cwd, space.machine)) ||
    (saved?.on === machine(space.machine) && saved.folder) || space.folder || undefined;
}

export function terminalDirectory(space, ps = panes(), current = focused()) {
  const active = space?.tabs?.find((t) => t.active)?.id;
  if (active && current?.tab === active && current.cwd) return current.cwd;
  return (active && (ps.find((p) => p.tab === active && p.focused && p.cwd)?.cwd ||
    ps.find((p) => p.tab === active && p.cwd)?.cwd)) || spaceDirectory(space, ps);
}

// Rendering can read the workspace without publishing it.
export function activeWorkspace({ remember = true } = {}) {
  const list = spaces();
  const sp = list.find((s) => s.active);
  if (!sp) return null;
  const ps = panes();
  const active = sp.tabs?.find((t) => t.active)?.id;
  const current = ps.find((p) => p.tab === active && !p.mod && p.focused && p.cwd) ?? ps.find((p) => p.tab === active && !p.mod && p.cwd);
  const saved = shared(WORKSPACES) ?? {};
  const previous = saved[sp.id]?.on === machine(sp.machine) ? saved[sp.id] : null;
  const primary = ownPanes(sp, ps)[0];
  const folder = knownRoot(current?.cwd || previewDirectory(sp, ps) || primary?.cwd || previous?.folder || spaceDirectory(sp, ps), sp.machine);
  const branch = current ? (current.branch ?? sp.branch ?? "") : (previous?.branch ?? primary?.branch ?? sp.branch);
  const next = { folder, branch, on: machine(sp.machine) };
  if (remember && JSON.stringify(previous) !== JSON.stringify(next)) {
    const live = new Set(list.map((s) => s.id));
    setShared(WORKSPACES, { ...Object.fromEntries(Object.entries(saved).filter(([id]) => live.has(id))), [sp.id]: next });
  }
  return { ...sp, folder, branch };
}

export function workspaceKey(sp) {
  return sp ? JSON.stringify([machine(sp.machine), sp.id, sp.folder, sp.branch ?? ""]) : "";
}

export function openTerminalTab(space = spaces().find((s) => s.active), options = {}, current = focused()) {
  if (!space) { run("space.new", options); return; }
  const tabs = space.tabs ?? [];
  run("tab.new", { ...options, space: space.id, folder: options.folder || terminalDirectory(space, panes(), current) });
  setShared("xmux.pending-append", { space: space.id, existing: tabs.map((t) => t.id), index: tabs.length + 1 });
}

export function splitTerminal(direction, pane) {
  const sp = spaces().find((s) => s.active);
  const ps = panes();
  const target = pane ? ps.find((p) => p.pane === pane) : ps.find((p) => p.pane === focused()?.pane);
  const owner = target ? spaces().find((s) => s.tabs?.some((t) => t.id === target.tab)) : sp;
  const folder = target?.cwd || terminalDirectory(owner, ps, focused());
  // terminal.open exposes folder; pane.split does not. Explicitly focus a
  // header's target first so splitting an unfocused pane goes beside that pane.
  if (target) run("pane.focus", { pane: target.pane });
  run("terminal.open", { place: direction, folder });
}

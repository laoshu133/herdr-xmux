// Generated from lib/xmux/tab-title.js. Run node scripts/sync-common.mjs.
import { home, terminals } from "herdr";

const PATH_TITLE = /^[~/]|^[A-Za-z]:\\/;

function shortFolder(cwd) {
  if (!cwd) return "";
  const root = home();
  if (cwd === root) return "~";
  return cwd.startsWith(`${root}/`) ? `~${cwd.slice(root.length)}` : cwd;
}

// The active tab follows its focused pane; other tabs keep their last focus.
// Agent launchers used to pass the program's generic name as an explicit tab
// name. Let those legacy labels follow the task; keep other custom names.
export function automaticTabTitle(tab, pane, publishedTitle) {
  if (!pane || pane.mod) {
    return tab.named ? tab.name : paneTitle(pane, publishedTitle || pane?.title, tab.name);
  }
  const record = pane.terminal ? terminals().find((r) => r.address === pane.terminal) : null;
  // Core tracks the current foreground program before the rendered pane catches up.
  const current = record ? {
    ...pane,
    program: record.program ?? pane.program,
    cwd: record.foreground?.cwd || pane.cwd || record.cwd,
  } : pane;
  const generic = pane.program?.agent && [pane.program.name, pane.program.key, pane.app]
    .some((name) => name && name.toLowerCase() === tab.name?.toLowerCase());
  if (tab.named && !generic) return tab.name;
  // Core can clear its title before the rendered pane catches up.
  const raw = record?.title ?? (record?.program?.shell && !pane.program?.shell ? "" : pane.title);
  return paneTitle(current, raw, tab.name);
}

// Floating terminals are published by Core without a tab or pane record.
export function floatingTerminalTitle(terminal) {
  if (!terminal) return "Local terminal";
  const pane = {
    program: terminal.program,
    cwd: terminal.foreground?.cwd || terminal.cwd,
  };
  return paneTitle(pane, terminal.title, "Local terminal");
}

function paneTitle(pane, raw, fallback) {
  const live = (raw ?? "").trim();
  const program = pane?.mod ? null : pane?.program;
  if (!pane?.mod && !program?.agent) {
    if (!program?.shell) return live && !PATH_TITLE.test(live) ? live : program?.name || live || fallback;
    const path = PATH_TITLE.test(live);
    if (live && !path && live !== program.name) return live;
    const location = path ? live : shortFolder(pane.cwd);
    return [program.name || "Terminal", location].filter(Boolean).join(" ");
  }
  const task = live.replace(/^[^\p{L}\p{N}~/]+/u, "").replace(/\s+\|\s+[^|]+$/, "").trim();
  const telling =
    task &&
    task !== program?.name &&
    !PATH_TITLE.test(task) &&
    !task.includes("@") &&
    task.toLowerCase() !== program?.key;
  return telling ? task : program?.name || task || fallback;
}

export function tabLead(tab, all, current = null) {
  const mine = all.filter((p) => p.tab === tab.id);
  if (tab.active) {
    return (
      mine.find((p) => p.pane === current?.pane) ??
      mine.find((p) => p.focused) ??
      mine.find((p) => p.program?.agent) ??
      mine[0]
    );
  }
  return mine.find((p) => p.focused) ?? mine.find((p) => p.program?.agent) ?? mine[0];
}

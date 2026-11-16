import { home } from "herdr";

function shortFolder(cwd) {
  if (!cwd) return "";
  const root = home();
  if (cwd === root) return "~";
  return cwd.startsWith(`${root}/`) ? `~${cwd.slice(root.length)}` : cwd;
}

// The active tab follows its focused pane; other tabs keep their last focus.
// Explicit tab names always win.
export function automaticTabTitle(tab, pane, publishedTitle) {
  if (tab.named) return tab.name;
  const raw = (pane?.terminal ? pane?.title : publishedTitle || pane?.title) ?? "";
  const live = raw
    .replace(/^[^\p{L}\p{N}~]+/u, "")
    .trim();
  const program = pane?.terminal ? pane?.program?.name : null;
  if (pane?.program?.shell) {
    const folder = shortFolder(pane.cwd);
    if (live && live !== program && !/^[~/]|^[A-Za-z]:\\/.test(live)) return live;
    const location = /^[~/]|^[A-Za-z]:\\/.test(live) ? live : folder;
    return [program || "Terminal", location].filter(Boolean).join(" ");
  }
  const task = live.replace(/\s+\|\s+[^|]+$/, "").trim();
  const path = /^[~/]|^[A-Za-z]:\\/.test(live);
  const telling =
    task &&
    task !== program &&
    !path &&
    !task.includes("@") &&
    task.toLowerCase() !== (pane?.terminal ? pane?.program?.key : null);
  return telling ? task : program || task || tab.name;
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


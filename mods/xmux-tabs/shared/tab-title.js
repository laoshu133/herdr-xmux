import { home, readTextFile, setShared, terminals } from "herdr";

const sessionTitles = new Map();
const sessionReads = new Set();
const SESSION_RETRY_MS = 15000;
const PATH_TITLE = /^[~/]|^[A-Za-z]:\\/;

function compactTitle(value) {
  const title = String(value ?? "")
    .replace(/^\s*#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return "";
  return title.length > 80 ? `${title.slice(0, 77).trimEnd()}…` : title;
}

function sessionTitle(text) {
  for (const line of String(text ?? "").split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const body = Array.isArray(content)
      ? content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
      : typeof content === "string"
        ? content
        : "";
    const title = compactTitle(body);
    if (title) return title;
  }
  return "";
}

function isPi(pane) {
  const key = pane?.program?.key?.toLowerCase();
  const name = pane?.program?.name?.toLowerCase();
  return pane?.app?.toLowerCase() === "pi" || key === "pi" || name === "pi";
}

function sessionSource(pane) {
  if (!isPi(pane)) return null;
  const address = pane?.terminal ?? pane?.pane;
  let record;
  try {
    record = terminals().find((item) => item?.address === address);
  } catch {
    return null;
  }
  const value = record?.labels?.["heeler.session"];
  let session;
  if (typeof value === "string") {
    try {
      session = JSON.parse(value);
    } catch {
      return null;
    }
  } else if (value && typeof value === "object") {
    session = value;
  }
  if (!session?.file) return null;
  const machine = String(record?.address ?? address ?? "").split("/")[0];
  return { file: session.file, on: String(record?.address ?? address).includes("/") ? machine : null };
}

// Pi keeps the conversation title in its session content, while its OSC title
// only contains `π - <folder>`. Read that first user message once per session.
function piConversationTitle(pane) {
  const source = sessionSource(pane);
  if (!source) return "";
  const cached = sessionTitles.get(source.file);
  if (cached?.title) return cached.title;
  if (cached && Date.now() - cached.at < SESSION_RETRY_MS) return "";
  if (sessionReads.has(source.file)) return "";
  sessionReads.add(source.file);
  readTextFile(source.file, { on: source.on })
    .then((text) => {
      const title = sessionTitle(text);
      sessionTitles.set(source.file, { title, at: Date.now() });
      sessionReads.delete(source.file);
      setShared("xmux.tab-title-refresh", Date.now());
    })
    .catch(() => {
      sessionTitles.set(source.file, { title: "", at: Date.now() });
      sessionReads.delete(source.file);
    });
  return "";
}

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
  const agent = !pane?.mod && pane?.program?.agent;
  const generic = agent && [pane.program.name, pane.program.key, pane.app]
    .some((name) => name && name.toLowerCase() === tab.name?.toLowerCase());
  if (tab.named && !generic) return tab.name;
  const conversation = piConversationTitle(pane);
  if (conversation) return conversation;
  // The rendered pane can retain an older title, especially while inactive.
  const record = !pane?.mod && pane?.terminal
    ? terminals().find((r) => r.address === pane.terminal)
    : null;
  const raw = pane?.mod ? publishedTitle || pane.title : record?.title || pane?.title;
  return paneTitle(pane, raw, tab.name);
}

// Floating terminals are published by Core without a tab or pane record.
export function floatingTerminalTitle(terminal) {
  if (!terminal) return "Local terminal";
  const pane = {
    terminal: terminal.address,
    app: terminal.report?.app,
    program: terminal.program,
    cwd: terminal.foreground?.cwd || terminal.cwd,
  };
  return piConversationTitle(pane) || paneTitle(pane, terminal.title, "Local terminal");
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

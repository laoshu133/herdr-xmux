import { home, readTextFile, setShared, terminals } from "herdr";

const sessionTitles = new Map();
const sessionReads = new Set();
const SESSION_RETRY_MS = 15000;

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
// Explicit tab names always win.
export function automaticTabTitle(tab, pane, publishedTitle) {
  if (tab.named) return tab.name;
  const conversation = piConversationTitle(pane);
  if (conversation) return conversation;
  const terminalPane = !pane?.mod;
  const raw = (terminalPane ? pane?.title : publishedTitle || pane?.title) ?? "";
  const live = raw
    .replace(/^[^\p{L}\p{N}~]+/u, "")
    .trim();
  const program = terminalPane ? pane?.program?.name : null;
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
    task.toLowerCase() !== (terminalPane ? pane?.program?.key : null);
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


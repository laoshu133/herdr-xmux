// Hosting CLIs always run on this computer, with the user's existing login.
import { exec, home } from "herdr";

const paths = new Map();
const missing = (text) => /command not found|no such file|could not start|not installed|os error 2|enoent/i.test(text);
export const transient = (text) => /\b(?:429|502|503|504)\b|timed? out|connection (?:reset|closed|aborted)|temporary failure|\beof\b|end of file|broken pipe|network is unreachable|tls handshake/i.test(text);

export async function cliExec(kind, args, { tools = {}, timeout = 15000, read = true } = {}) {
  const name = kind === "gitlab" ? "glab" : "gh";
  const configured = tools[kind] || name;
  const candidates = configured === name
    ? [...new Set([paths.get(name), name, `${home()}/.local/bin/${name}`, `${home()}/.local/.bin/${name}`, `${home()}/.bin/${name}`, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].filter(Boolean))]
    : [configured];
  for (const command of candidates) {
    let result;
    try { result = await exec(command, args, { on: null, timeout }); }
    catch (e) {
      if (missing(String(e.message ?? e))) continue;
      throw e;
    }
    const message = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    if (result.code === 127 || missing(message) && result.code !== 0) continue;
    if (configured === name) paths.set(name, command);
    // Read requests may be retried once. Writes must never be replayed.
    if (read && result.code !== 0 && transient(message))
      result = await exec(command, args, { on: null, timeout });
    if (result.code !== 0) {
      const text = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
      const error = new Error(text || `${name} request failed.`);
      error.status = Number(/\b(401|403|404|405|409|422|429|500|502|503|504)\b/.exec(text)?.[1]) || null;
      if (error.status === 401 || /not logged|not authenticated|authentication required/i.test(text))
        error.message = `${name} CLI is not authenticated for this host. Run \`${name} auth login --hostname <host>\`, then refresh.`;
      throw error;
    }
    return result;
  }
  throw new Error(`${name} CLI is not installed. Install ${name} or configure its full path, then refresh.`);
}

export async function cliPath(kind, tools = {}) {
  const name = kind === "gitlab" ? "glab" : "gh";
  if (tools[kind] && tools[kind] !== name) return tools[kind];
  if (!paths.has(name)) await cliExec(kind, ["--version"], { tools });
  return paths.get(name);
}

export const queryString = (values) => Object.entries(values).filter(([, v]) => v !== undefined && v !== null && v !== "")
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");

export async function hostingApi(provider, endpoint, { method = "GET", fields = {}, tools, raw = false, headers = [], readOnly = false } = {}) {
  const args = ["api", "--hostname", provider.host, "--method", method, endpoint];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    // --raw-field avoids @file expansion and boolean inference in external text.
    args.push("--raw-field", `${key}=${String(value)}`);
  }
  for (const header of headers) args.push("--header", header);
  const read = method === "GET" || readOnly && endpoint === "graphql" && /^\s*query\b/.test(fields.query || "");
  let reply;
  try { reply = await cliExec(provider.kind, args, { tools, read, timeout: read ? 15000 : 30000 }); }
  catch (e) { e.message = e.message.replace("<host>", provider.host); throw e; }
  if (raw) return reply.stdout || "";
  try { return JSON.parse(reply.stdout || "null"); }
  catch { throw new Error(`${provider.kind === "gitlab" ? "GitLab" : "GitHub"} returned invalid JSON.`); }
}

export async function apiPages(provider, endpoint, options = {}) {
  const items = [];
  for (let page = 1; page <= 50; page++) {
    const rows = await hostingApi(provider, `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`, options);
    if (!Array.isArray(rows)) throw new Error("Unexpected paginated response from the hosting service.");
    items.push(...rows);
    if (rows.length < 100) return items;
  }
  throw new Error("This result exceeds 5,000 items. Open it on the hosting service to view the complete result.");
}

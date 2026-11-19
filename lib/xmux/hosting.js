// Hosting CLIs always run on this computer, with the user's existing login.
import { exec, home } from "herdr";
import { cliCandidates, cliName, missingExecutable, missingOnLaunch, notAuthenticated, outputText } from "./hosting-cli.js";

const paths = new Map();
export const transient = (text) => /\b(?:429|502|503|504)\b|timed? out|connection (?:reset|closed|aborted)|temporary failure|\beof\b|end of file|broken pipe|network is unreachable|tls handshake/i.test(text);

export async function cliExec(kind, args, { tools = {}, timeout = 15000, read = true, cwd, host = "<host>" } = {}) {
  const name = cliName(kind);
  const configured = tools[kind] || name;
  const candidates = cliCandidates(configured, home(), paths.get(configured));
  const options = { on: null, timeout, ...(cwd ? { cwd } : {}) };
  for (const command of candidates) {
    let result;
    try { result = await exec(command, args, options); }
    catch (e) {
      if (missingOnLaunch(String(e.message ?? e))) continue;
      throw e;
    }
    const message = outputText(result);
    if (result.code === 127 || (result.code !== 0 && missingExecutable(message))) continue;
    if (configured === name) paths.set(name, command);
    // Read requests may be retried once. Writes must never be replayed.
    if (read && result.code !== 0 && transient(message))
      result = await exec(command, args, options);
    if (result.code !== 0) {
      const text = outputText(result);
      const error = new Error(text || `${name} request failed.`);
      error.status = Number(/\b(401|403|404|405|409|422|429|500|502|503|504)\b/.exec(text)?.[1]) || null;
      if (notAuthenticated(text))
        error.message = `${name} CLI is not authenticated for this host. Run \`${name} auth login --hostname ${host}\`, then refresh.`;
      throw error;
    }
    return result;
  }
  throw new Error(`${name} CLI is not installed. Install ${name} or configure its full path, then refresh.`);
}

export async function cliPath(kind, tools = {}) {
  const name = cliName(kind);
  if (tools[kind] && tools[kind] !== name) return cliCandidates(tools[kind], home())[0];
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
  const reply = await cliExec(provider.kind, args, { tools, read, host: provider.host, timeout: read ? 15000 : 30000 });
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

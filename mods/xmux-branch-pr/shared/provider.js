// Repository address parsing and CLI-backed provider detection shared by Branch PR.
// The Git remote supplies only the host and path. `gh`/`glab` authentication and
// repository access decide which provider is actually usable, so Enterprise and
// self-hosted installations work without host-name conventions.
import { exec, home } from "herdr";
import { cachedQuery } from "./query-cache.js";

const HOST_PATTERN = /^[A-Za-z0-9.-]+$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

export function remoteInfo(remote) {
  const value = String(remote ?? "").trim();
  const match = /^(?:(?:https?|git|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::[0-9]+)?\/|git@([^:/]+):)(.+?)(?:\.git)?\/?$/.exec(value);
  if (!match) return null;
  const host = (match[1] ?? match[2] ?? "").toLowerCase();
  const path = (match[3] ?? "").replace(/^\/+|\/+$/g, "");
  if (!HOST_PATTERN.test(host)) return null;
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2 || !segments.every((s) => SEGMENT_PATTERN.test(s))) return null;
  return { host, path, repo: segments.join("/"), remote: value };
}

export function providerFromRemote(remote) {
  const parsed = remoteInfo(remote);
  if (!parsed) return null;
  if (parsed.host === "github.com" || /^github(?:\.com)?-|^ssh\.github\.com$/.test(parsed.host))
    return { kind: "github", host: "github.com", repo: parsed.repo.split("/").slice(0, 2).join("/") };
  if (parsed.host === "gitlab.com" || parsed.host.includes("gitlab"))
    return { kind: "gitlab", host: parsed.host, repo: parsed.repo };
  return null;
}

export function repositoryFromRemote(remote) {
  const parsed = remoteInfo(remote);
  if (!parsed) throw new Error("The remote does not contain a valid repository address.");
  return parsed.repo;
}

function outputText(result) {
  return `${result?.stderr || ""}\n${result?.stdout || ""}`.trim();
}

async function runCli(command, args, options) {
  const candidates = [command];
  if (["gh", "glab"].includes(command)) candidates.push(`~/.local/bin/${command}`, `~/.local/.bin/${command}`, `~/.bin/${command}`, `/opt/homebrew/bin/${command}`, `/usr/local/bin/${command}`);
  let result;
  for (const candidate of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { result = await exec(candidate.startsWith("~/") ? `${home()}/${candidate.slice(2)}` : candidate, args, options); }
      catch (error) { result = { code: 127, stdout: "", stderr: String(error.message ?? error) }; }
      if (result.code === 0 || !/\bEOF\b|connection (?:reset|closed|aborted)|timed out|timeout|502|503|504/i.test(outputText(result))) break;
    }
    if (result.code !== 127 && !/no such file|os error 2|command not found|enoent/i.test(outputText(result))) return result;
  }
  return result;
}

function missing(text) {
  return /command not found|not found|is not installed|no such file/i.test(text);
}

function authFailure(text) {
  return /not logged|not authenticated|authentication required|unauthorized|forbidden|401|403|authentication failed|http 4\d\d/i.test(text);
}

function jsonRepo(stdout, kind, fallback) {
  try {
    const row = JSON.parse(stdout || "null") || {};
    const value = kind === "github"
      ? row.nameWithOwner
      : row.path_with_namespace || row.name_with_namespace || row.path || row.name;
    if (typeof value === "string" && value.trim()) return value.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  } catch {
    // The CLI may return a useful success response without JSON on older versions.
  }
  return fallback;
}

function githubRepo(parsed, value) {
  const parts = String(value).split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : parsed.repo;
}

export function resolveProvider(remote, options = {}) {
  const parsed = remoteInfo(remote);
  if (!parsed) return Promise.reject(new Error("The remote does not contain a valid repository address."));
  const tools = { github: options.tools?.github || "gh", gitlab: options.tools?.gitlab || "glab" };
  const configured = configuredProvider(parsed, options.hosts);
  const key = JSON.stringify(["provider", parsed.host, parsed.repo, tools, configured]);
  return cachedQuery(key, 600000, async () => {
    // Public and recognizable hosts already identify the provider. The first
    // real read verifies access; discovery should not spend another API call.
    const recognized = configured ?? providerFromRemote(remote);
    if (recognized) return recognized;
    const target = `${parsed.host}/${parsed.repo}`;
    const preferred = providerFromRemote(remote)?.kind === "gitlab" ? ["gitlab", "github"] : ["github", "gitlab"];
    const failures = [];
    for (const kind of preferred) {
      const tool = kind === "github" ? tools.github || "gh" : tools.gitlab || "glab";
      const args = kind === "github" ? ["repo", "view", target, "--json", "nameWithOwner"] : ["repo", "view", parsed.remote, "--output", "json"];
      // Hosting credentials belong to this computer, including remote checkouts.
      const reply = await runCli(tool, args, { on: null, timeout: 8000 });
      if (reply.code === 0) {
        const repo = jsonRepo(reply.stdout, kind, parsed.repo);
        return { kind, host: parsed.host, repo: kind === "github" ? githubRepo(parsed, repo) : repo };
      }
      const text = outputText(reply);
      failures.push({ text, missing: missing(text), auth: authFailure(text) });
    }
    if (failures.every((f) => f.missing)) throw new Error("Neither gh nor glab CLI is installed. Install one and log in before opening this panel.");
    if (failures.some((f) => f.auth)) throw new Error(`Neither authenticated gh nor glab can access ${target}. Run the matching CLI's auth login, then refresh.`);
    throw new Error(`Neither gh nor glab could access ${target}. Check the repository address and CLI authorization.`);
  }, { share: true });
}

// Entries: { remote: "git-company", kind: "gitlab", host: "code.company.com" }.
// Arrays let settings retain a checked schema without arbitrary setting keys.
export function configuredProvider(parsed, hosts = []) {
  const item = hosts.find?.((h) => h.remote?.toLowerCase() === parsed.host);
  if (!item) return null;
  if (!["github", "gitlab"].includes(item.kind) || !HOST_PATTERN.test(item.host || ""))
    throw new Error(`Invalid hosting configuration for ${parsed.host}.`);
  return { kind: item.kind, host: item.host.toLowerCase(), repo: parsed.repo };
}

export const requestNumber = (item) => `${item?.provider?.kind === "gitlab" ? "!" : "#"}${item?.number}`;
export const requestName = (provider, plural = false) => provider?.kind === "gitlab"
  ? plural ? "merge requests" : "merge request" : plural ? "pull requests" : "pull request";
export const requestShort = (item) => `${item?.provider?.kind === "gitlab" ? "MR" : "PR"} ${requestNumber(item)}`;
export const repositoryKey = (provider, repo = provider?.repo) => JSON.stringify([provider?.kind, provider?.host, repo]);
export const requestKey = (item) => JSON.stringify([item?.provider?.kind, item?.provider?.host, item?.repository, item?.number]);
export const requestRef = (item) => item?.provider?.kind === "gitlab"
  ? `refs/merge-requests/${item.number}/head` : `refs/pull/${item.number}/head`;
export const encodeBinding = (item) => JSON.stringify({ v: 2, provider: item.provider, repo: item.repository, number: item.number });
export function decodeBinding(value) {
  try {
    const row = JSON.parse(value);
    if (row.v === 2 && ["github", "gitlab"].includes(row.provider?.kind) && HOST_PATTERN.test(row.provider.host)
      && typeof row.repo === "string" && row.repo.split("/").length >= 2
      && row.repo.split("/").every(s => SEGMENT_PATTERN.test(s)) && Number.isSafeInteger(row.number) && row.number > 0) return row;
  } catch { /* Legacy GitHub worktree association. */ }
  const old = /^([\w.-]+\/[\w.-]+)#([1-9][0-9]*)$/.exec(String(value || "").trim());
  return old ? { v: 1, provider: { kind: "github", host: "github.com" }, repo: old[1], number: Number(old[2]) } : null;
}

export function requestSearch(text, provider, repo) {
  const query = String(text || "").trim();
  if (!/^https?:\/\//i.test(query)) return query;
  const link = /^https?:\/\/([^/]+)\/(.+?)\/(?:pull)\/([1-9][0-9]*)\/?(?:[?#].*)?$/.exec(query)
    || /^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/([1-9][0-9]*)\/?(?:[?#].*)?$/.exec(query);
  if (!link) throw new Error("Paste a pull request or merge request URL, or search by text.");
  const kind = query.includes("/-/merge_requests/") ? "gitlab" : "github";
  if (provider.kind !== kind || provider.host.toLowerCase() !== link[1].toLowerCase() || repo.toLowerCase() !== link[2].toLowerCase())
    throw new Error("This link belongs to another host or repository. Select its repository before searching.");
  return link[3];
}

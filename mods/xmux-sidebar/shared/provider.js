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
      catch (error) {
        const message = String(error.message ?? error);
        result = { code: missingExecutable(message) ? 127 : 1, stdout: "", stderr: message };
      }
      if (result.code === 0 || !/\bEOF\b|connection (?:reset|closed|aborted)|timed out|timeout|502|503|504/i.test(outputText(result))) break;
    }
    if (result.code !== 127 && !missingExecutable(outputText(result))) return result;
  }
  return result;
}

function missingExecutable(text) {
  return /os error 2|\benoent\b|command not found|cannot run[^\n]*no such file|^\S+: (?:not found|no such file or directory)$/im.test(text);
}

function jsonRepo(stdout, kind) {
  try {
    const row = JSON.parse(stdout);
    const repo = kind === "github" ? row?.full_name : row?.path_with_namespace;
    const parts = typeof repo === "string" ? repo.split("/") : [];
    if (parts.length >= 2 && parts.every((part) => SEGMENT_PATTERN.test(part))) return repo;
  } catch {
    // Repository endpoints return a provider-specific JSON document.
  }
  return null;
}

const localOptions = { on: null, timeout: 8000 };

function probeCli(tool) {
  return cachedQuery(JSON.stringify(["provider-cli", tool]), 600000,
    () => runCli(tool, ["--version"], localOptions));
}

function probeLogin(tool, host) {
  return cachedQuery(JSON.stringify(["provider-login", tool, host]), 60000,
    () => runCli(tool, ["auth", "status", "--hostname", host], localOptions));
}

export function resolveProvider(remote, options = {}) {
  const parsed = remoteInfo(remote);
  if (!parsed) return Promise.reject(new Error("The remote does not contain a valid repository address."));
  const tools = { github: options.tools?.github || "gh", gitlab: options.tools?.gitlab || "glab" };
  const configured = configuredProvider(parsed, options.hosts);
  const key = JSON.stringify(["provider:v2", parsed.host, parsed.repo, tools, configured]);
  return cachedQuery(key, 600000, async () => {
    if (configured) return configured;
    const target = `${parsed.host}/${parsed.repo}`;
    const checked = await Promise.all(Object.entries(tools).map(async ([kind, tool]) =>
      ({ kind, tool, version: await probeCli(tool) })));
    const available = checked.filter(({ version }) => version.code === 0);
    if (!available.length) {
      if (checked.every(({ version }) => version.code === 127 || missingExecutable(outputText(version))))
        throw new Error("Neither gh nor glab CLI is installed. Install one and log in before opening this panel.");
      throw new Error("Could not run either hosting CLI. Check the CLI path and permissions, then refresh.");
    }
    const logins = await Promise.all(available.map(async (cli) =>
      ({ ...cli, auth: await probeLogin(cli.tool, parsed.host) })));
    // Check repository access only through a CLI logged into the exact remote host.
    const repositories = await Promise.all(logins.filter(({ auth }) => auth.code === 0).map(async ({ kind, tool }) => {
      const endpoint = kind === "github" ? `repos/${parsed.repo}` : `projects/${encodeURIComponent(parsed.repo)}`;
      const reply = await runCli(tool, ["api", "--hostname", parsed.host, endpoint], localOptions);
      return { kind, reply, repo: reply.code === 0 ? jsonRepo(reply.stdout, kind) : null };
    }));
    const matches = repositories.filter(({ repo }) => repo);
    if (matches.length === 1) return { kind: matches[0].kind, host: parsed.host, repo: matches[0].repo };
    if (matches.length > 1) throw new Error(`Both hosting CLIs can access ${target}. Configure a host mapping for this remote.`);
    const failed = [...logins.map(({ auth }) => auth), ...repositories.map(({ reply }) => reply)];
    if (failed.some((reply) => /timed? out|timeout|network is unreachable|no route to host/i.test(outputText(reply))))
      throw new Error(`Could not reach ${parsed.host} from this computer. Check the network connection for this Git host, then refresh.`);
    if (!repositories.length)
      throw new Error(`No installed hosting CLI is authenticated for ${parsed.host}. Run the matching CLI's auth login or configure an SSH host mapping, then refresh.`);
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

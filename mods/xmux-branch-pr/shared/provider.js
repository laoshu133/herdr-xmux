// Repository address parsing and CLI-backed provider detection shared by Branch PR.
// The Git remote supplies only the host and path. `gh`/`glab` authentication and
// repository access decide which provider is actually usable, so Enterprise and
// self-hosted installations work without host-name conventions.
import { exec } from "herdr";
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
  try {
    return await exec(command, args, options);
  } catch (error) {
    // Herdr's exec rejects when the executable cannot be started. Treat that
    // exactly like a non-zero CLI result so the other provider can be tried.
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
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
  const key = JSON.stringify(["provider", parsed.host, parsed.repo, tools]);
  return cachedQuery(key, 600000, async () => {
    // Public and recognizable hosts already identify the provider. The first
    // real read verifies access; discovery should not spend another API call.
    const recognized = providerFromRemote(remote);
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

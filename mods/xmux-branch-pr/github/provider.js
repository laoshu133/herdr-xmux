// Repository address parsing and CLI-backed provider detection shared by Branch PR.
// The Git remote supplies only the host and path. `gh`/`glab` authentication and
// repository access decide which provider is actually usable, so Enterprise and
// self-hosted installations work without host-name conventions.
import { exec } from "herdr";

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

export async function resolveProvider(remote, options = {}) {
  const parsed = remoteInfo(remote);
  if (!parsed) throw new Error("The remote does not contain a valid repository address.");
  const target = `${parsed.host}/${parsed.repo}`;
  const failures = [];

  const gh = await runCli("gh", ["repo", "view", target, "--json", "nameWithOwner"], options);
  if (gh.code === 0) {
    const repo = githubRepo(parsed, jsonRepo(gh.stdout, "github", parsed.repo));
    return { kind: "github", host: parsed.host, repo };
  }
  failures.push({ tool: "gh", text: outputText(gh), missing: missing(outputText(gh)), auth: authFailure(outputText(gh)) });

  const glab = await runCli("glab", ["repo", "view", parsed.remote, "--output", "json"], options);
  if (glab.code === 0) {
    const repo = jsonRepo(glab.stdout, "gitlab", parsed.repo);
    return { kind: "gitlab", host: parsed.host, repo };
  }
  failures.push({ tool: "glab", text: outputText(glab), missing: missing(outputText(glab)), auth: authFailure(outputText(glab)) });

  if (failures.every((failure) => failure.missing))
    throw new Error("Neither gh nor glab CLI is installed. Install one and log in before opening this panel.");
  if (failures.some((failure) => failure.auth))
    throw new Error(`Neither authenticated gh nor glab can access ${target}. Run the matching CLI's auth login, then refresh.`);
  throw new Error(`Neither gh nor glab could access ${target}. Check the repository address and CLI authorization.`);
}

export function providerName(provider) {
  return provider?.kind === "gitlab" ? "GitLab" : "GitHub";
}

export function providerUrl(repo, provider) {
  const p = typeof provider === "string" ? { kind: provider } : provider;
  const host = p?.host || (p?.kind === "gitlab" ? "gitlab.com" : "github.com");
  return `https://${host}/${repo}`;
}

export function providerProblem(message, provider) {
  const text = String(message ?? "");
  const name = providerName(provider);
  const tool = provider?.kind === "gitlab" ? "glab" : "gh";
  if (/no github or gitlab remote|must point to a github or gitlab|unsupported repository|no .* remote found|valid repository address/i.test(text))
    return {
      kind: "unsupported",
      title: "GitHub or GitLab repository required",
      detail: "Open a folder with a repository remote that your authenticated gh or glab CLI can access.",
      command: "git remote -v",
    };
  if (new RegExp(`${tool} CLI \\(.*\\) is not installed`, "i").test(text) || /command not found|is not installed/i.test(text))
    return {
      kind: "missing",
      title: `${name} CLI isn't installed`,
      detail: `This panel reads and writes through ${tool}. Install it, log in, then try again.`,
      command: `${tool} auth login`,
      url: tool === "glab" ? "https://gitlab.com/gitlab-org/cli" : "https://cli.github.com",
    };
  if (/not logged in|not authenticated|authentication required|auth.*required|neither authenticated gh nor glab/i.test(text))
    return {
      kind: "logged-out",
      title: "Git hosting CLI isn't logged in",
      detail: "This panel verifies the repository with gh and glab using their local login state. Run the matching CLI's auth login, then try again.",
      command: `${tool} auth login`,
      url: tool === "glab" ? "https://gitlab.com/gitlab-org/cli" : "https://cli.github.com",
    };
  return null;
}

export const providerIcon = () => "github";

// Repository provider detection and CLI guidance shared by Branch PR.
// The provider is inferred from the selected Git remote; no provider setting is
// required and no network request is made during detection.

const HOST_PATTERN = /^[A-Za-z0-9.-]+$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

function parseRemote(remote) {
  const value = String(remote ?? "").trim();
  const match = /^(?:(?:https?|git|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::[0-9]+)?\/|git@([^:/]+):)(.+?)(?:\.git)?\/?$/.exec(value);
  if (!match) return null;
  const host = (match[1] ?? match[2] ?? "").toLowerCase();
  const path = (match[3] ?? "").replace(/^\/+|\/+$/g, "");
  if (!HOST_PATTERN.test(host)) return null;
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2 || !segments.every((s) => SEGMENT_PATTERN.test(s))) return null;
  if (host === "github.com" || /^github(?:\.com)?-|^ssh\.github\.com$/.test(host))
    return { kind: "github", host: "github.com", repo: segments.slice(0, 2).join("/") };
  if (host === "gitlab.com" || host.includes("gitlab"))
    return { kind: "gitlab", host, repo: segments.join("/") };
  return null;
}

export function providerFromRemote(remote) {
  return parseRemote(remote);
}

export function repositoryFromRemote(remote) {
  const provider = parseRemote(remote);
  if (!provider) throw new Error("The remote must point to a GitHub or GitLab repository.");
  return provider.repo;
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
  if (/no github or gitlab remote|must point to a github or gitlab|unsupported repository|no .* remote found/i.test(text))
    return {
      kind: "unsupported",
      title: "GitHub or GitLab repository required",
      detail: "Open a folder whose Git remote points to GitHub or GitLab. The panel detects the provider from that remote.",
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
  if (/not logged in|not authenticated|authentication required|auth.*required/i.test(text))
    return {
      kind: "logged-out",
      title: `${name} CLI isn't logged in`,
      detail: `This panel uses your ${tool} login. Run this in a terminal, then try again.`,
      command: `${tool} auth login`,
      url: tool === "glab" ? "https://gitlab.com/gitlab-org/cli" : "https://cli.github.com",
    };
  return null;
}

export const providerIcon = () => "github";

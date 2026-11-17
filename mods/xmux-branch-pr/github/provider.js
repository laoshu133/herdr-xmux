export { remoteInfo, providerFromRemote, repositoryFromRemote, resolveProvider, requestNumber, requestName, requestShort, requestKey, repositoryKey, requestRef, encodeBinding, decodeBinding } from "../shared/provider.js";

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
      command: `${tool} auth login --hostname ${provider?.host || (tool === "glab" ? "gitlab.com" : "github.com")}`,
      url: tool === "glab" ? "https://gitlab.com/gitlab-org/cli" : "https://cli.github.com",
    };
  if (/not logged in|not authenticated|not authenticated for|authentication required|auth.*required|neither authenticated gh nor glab/i.test(text))
    return {
      kind: "logged-out",
      title: "Git hosting CLI isn't logged in",
      detail: "This panel verifies the repository with gh and glab using their local login state. Run the matching CLI's auth login, then try again.",
      command: `${tool} auth login --hostname ${provider?.host || (tool === "glab" ? "gitlab.com" : "github.com")}`,
      url: tool === "glab" ? "https://gitlab.com/gitlab-org/cli" : "https://cli.github.com",
    };
  return null;
}

export const providerIcon = (provider) => provider?.kind === "gitlab" ? "gitlab" : "github";

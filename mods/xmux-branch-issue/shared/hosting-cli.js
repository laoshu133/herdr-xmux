// Generated from lib/xmux/hosting-cli.js. Run node scripts/sync-common.mjs.
export const cliName = (kind) => kind === "gitlab" ? "glab" : "gh";

export function cliCandidates(command, home, preferred) {
  if (command.startsWith("~/")) return [`${home}/${command.slice(2)}`];
  const paths = ["gh", "glab"].includes(command)
    ? [`${home}/.local/bin/${command}`, `${home}/.local/.bin/${command}`, `${home}/.bin/${command}`,
      `/opt/homebrew/bin/${command}`, `/usr/local/bin/${command}`]
    : [];
  return [...new Set([preferred, command, ...paths].filter(Boolean))];
}

export const outputText = (result) =>
  `${result?.stderr || ""}\n${result?.stdout || ""}`.trim();

// A CLI may echo API errors in its output. Fall back to another executable
// only when the error identifies a missing command.
export const missingExecutable = (text) =>
  /os error 2|\benoent\b|command not found|cannot run[^\n]*no such file|^\S+: (?:not found|no such file or directory)$/im.test(text);

export const missingOnLaunch = (text) =>
  missingExecutable(text) || /^no such file or directory\.?$/i.test(text.trim());

export const notAuthenticated = (text) =>
  /not logged|not authenticated|authentication required|auth.*required|\b401\b|authentication failed|\bunauthorized\b|neither authenticated gh nor glab/i.test(text);

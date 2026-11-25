// Reading a space's checkout from Git, with no view state.
import { exec } from "herdr";
import { spaceDirectory, rememberRoot } from "../shared/context.js";
import { readWorktreeStatus, resolveGitRoot } from "../shared/git-status.js";

const basename = (path) => path.replace(/\/+$/, "").split("/").pop();

// The first terminal defines a space's checkout, not whichever pane is focused.
// Pass a panes() snapshot: each API call copies the full pane list.
export function spaceFolder(space, paneList) {
  return spaceDirectory(space, paneList);
}

export const checkoutKey = (space, paneList) =>
  JSON.stringify([space.machine ?? null, spaceFolder(space, paneList)]);

// Branch, ahead/behind and repository, or null if this isn't a repository.
// Throws when Git couldn't be asked, so the caller keeps what it knew.
export async function readCheckout(cwd, on) {
  const top = await resolveGitRoot(cwd, on);
  if (!top) return null;

  // The repo's own .git folder names it; a worktree's top differs from it.
  const [{ status }, common] = await Promise.all([
    readWorktreeStatus(top, on),
    exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: top, on }),
  ]);
  if (common.code !== 0) throw new Error("Cannot read repository metadata");

  rememberRoot(cwd, top, on);
  const repo = common.stdout.trim();
  return {
    name: repo.endsWith("/.git")
      ? basename(repo.slice(0, -5))
      : basename(repo).replace(/\.git$/, ""),
    branch: status.branch,
    ahead: status.ahead,
    behind: status.behind,
    repo: JSON.stringify([on, repo]),
    linked: repo !== top + "/.git",
  };
}

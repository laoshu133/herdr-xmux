// Reading a space's checkout from Git, with no view state.
import { exec } from "herdr";
import { spaceDirectory, rememberRoot } from "../shared/context.js";
import { readGitStatus } from "../shared/git-status.js";

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
  const status = await readGitStatus(cwd, on);
  if (!status) return null;

  // The repo's own .git folder names it; a worktree's top differs from it.
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    on,
  });
  if (top.code !== 0 || common.code !== 0) throw new Error("Cannot read repository metadata");

  rememberRoot(cwd, top.stdout.trim(), on);
  const repo = common.stdout.trim();
  return {
    name: repo.endsWith("/.git")
      ? basename(repo.slice(0, -5))
      : basename(repo).replace(/\.git$/, ""),
    branch: status.branch,
    ahead: status.ahead,
    behind: status.behind,
    repo: JSON.stringify([on, repo]),
    linked: repo !== `${top.stdout.trim()}/.git`,
  };
}

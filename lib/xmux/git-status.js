import { exec } from "herdr";

export function parseGitStatus(text) {
  const status = { branch: null, oid: null, ahead: 0, behind: 0,
    conflicted: false, modified: false, untracked: false };
  for (const record of text.split("\0")) {
    if (record.startsWith("# branch.head ")) status.branch = record.slice(14);
    else if (record.startsWith("# branch.oid ")) status.oid = record.slice(13);
    else if (record.startsWith("# branch.ab ")) {
      const [ahead, behind] = record.slice(12).split(" ");
      status.ahead = Number(ahead) || 0;
      status.behind = Math.abs(Number(behind)) || 0;
    } else if (record.startsWith("u ")) {
      status.conflicted = true;
      status.modified = true;
    } else if (record.startsWith("1 ")) status.modified = true;
    else if (record.startsWith("? ")) status.untracked = true;
  }
  return status;
}

export async function readGitStatus(cwd, on) {
  const result = await exec("git", [
    "--no-optional-locks", "-c", "core.fsmonitor=false",
    "status", "--porcelain=v2", "--branch", "--ahead-behind", "-z", "--no-renames", "--untracked-files=normal",
  ], { cwd, on, timeout: 5000 });
  if (result.code === 0) return parseGitStatus(result.stdout);
  if (/not a git repository/i.test(result.stderr)) return null;
  throw new Error(result.stderr || "Cannot read Git status");
}

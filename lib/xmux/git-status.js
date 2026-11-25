import { exec } from "herdr";

// Herdr shares its JS global across mods. Keep full scans in memory, including
// large worktrees whose file lists would not fit the shared metadata cache.
const { roots, scans } = globalThis[Symbol.for("xmux.worktreeStatus")] ??=
  { roots: new Map(), scans: new Map() };
const keyOf = (on, path) => JSON.stringify([on ?? null, path]);

export function parseGitStatus(text) {
  const status = { branch: null, oid: null, ahead: 0, behind: 0,
    conflicted: false, modified: false, untracked: false };
  const files = new Map();
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
      files.set(afterFields(record, 10), record.slice(2, 4));
    } else if (record.startsWith("1 ")) {
      status.modified = true;
      files.set(afterFields(record, 8), record.slice(2, 4).replaceAll(".", " "));
    } else if (record.startsWith("? ")) {
      status.untracked = true;
      files.set(record.slice(2), "??");
    }
  }
  return { status, files, porcelain: [...files].map(([path, xy]) => xy + " " + path).join("\0") };
}

function afterFields(record, count) {
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const space = record.indexOf(" ", offset);
    if (space === -1) return "";
    offset = space + 1;
  }
  return record.slice(offset);
}

function memoize(cache, key, ttl, read) {
  const now = Date.now();
  for (const [name, entry] of cache) if (entry.until <= now) cache.delete(name);
  const previous = cache.get(key);
  if (previous) return previous.promise;
  const entry = { started: now, until: Infinity };
  entry.promise = Promise.resolve().then(async () => {
    try {
      const result = await read();
      if (cache.get(key) !== entry) return memoize(cache, key, ttl, read);
      entry.until = Date.now() + ttl(Date.now() - now, result);
      return result;
    } catch (error) {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    }
  });
  cache.set(key, entry);
  return entry.promise;
}

export function resolveGitRoot(cwd, on) {
  if (!cwd) return Promise.resolve(null);
  return memoize(roots, keyOf(on, cwd), (_elapsed, root) => root ? 300000 : 1000, async () => {
    const result = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on, timeout: 5000 });
    if (result.code === 0) return result.stdout.replace(/\r?\n$/, "");
    if (/not a git repository/i.test(result.stderr)) return null;
    throw new Error(result.stderr || "Cannot locate Git worktree");
  });
}

export function readWorktreeStatus(root, on) {
  return memoize(scans, keyOf(on, root), (elapsed) => Math.min(60000, Math.max(1000, elapsed * 5)), async () => {
    const result = await exec("git", [
      "--no-optional-locks", "-c", "core.fsmonitor=false",
      "status", "--porcelain=v2", "--branch", "--ahead-behind", "-z", "--no-renames", "--untracked-files=all",
    ], { cwd: root, on, timeout: 10000 });
    if (result.code === 0) return parseGitStatus(result.stdout);
    if (/not a git repository/i.test(result.stderr)) invalidateGitRoot(root, on);
    throw new Error(result.stderr || "Cannot read Git status");
  });
}

function invalidateGitRoot(root, on) {
  for (const [key] of roots) {
    const [machine, folder] = JSON.parse(key);
    if (machine === (on ?? null) && (folder === root || folder.startsWith(root + "/"))) roots.delete(key);
  }
}

export function invalidateWorktreeStatus(root, on, observedAt = Infinity) {
  if (!root) return;
  const key = keyOf(on, root);
  const scan = scans.get(key);
  // A scan started after the change can also serve another panel's watcher.
  if (scan && scan.started <= observedAt) scans.delete(key);
}

export async function readGitStatus(cwd, on) {
  const root = await resolveGitRoot(cwd, on);
  return root ? (await readWorktreeStatus(root, on)).status : null;
}

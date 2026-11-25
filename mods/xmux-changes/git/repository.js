// The mod's Git state: following the repository, changing the index, history,
// commit and amend. The reads themselves are in git-reads.js.
import { exec, watchFolder, shared, setShared, window } from "herdr";
import { activeWorkspace, rememberRoot } from "../shared/context.js";
import { cachedQuery, invalidateQueries } from "../shared/query-cache.js";
import { invalidateWorktreeStatus, readWorktreeStatus, resolveGitRoot } from "../shared/git-status.js";
import {
  readStatus,
  readBranchAndRepo,
  readCommitted,
  readRemoteHead,
  readBehind,
  readLog,
  readCommitFiles,
} from "./reads.js";

// Reads must not take optional index locks or start fsmonitor helpers.
const READ_ONLY = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.autoRefreshIndex=false",
];
const BULK_PATHS = 200; // Per command, to stay under the system's argument limit.

// The active terminal's folder, or the repository saved for our own diff tab,
// since a mod pane has no terminal folder.
function activeLocation() {
  const sp = activeWorkspace();
  return { cwd: sp?.folder, on: sp?.machine ?? null };
}

export const gitMethods = {
  // ── Repository ────────────────────────────────────────────────────────────

  location() {
    if (this.mode === "diff")
      return (
        (shared("xmux-changes.diff-tabs") ?? {})[this.diffSpace]?.source ??
        this.source ??
        activeLocation()
      );
    return this.source ?? activeLocation();
  },

  // Both folder and machine: the same path on two machines is two repositories.
  contextKey() {
    return JSON.stringify(this.location());
  },

  git(args, root = this.root, on = this.on) {
    const command = args.find((a) => !a.startsWith("-"));
    const read = ["status", "diff", "show", "log", "rev-parse", "merge-base", "rev-list", "symbolic-ref", "remote", "ls-files"].includes(command);
    // Commit hooks may legitimately outlive a read's deadline.
    return exec("git", [...READ_ONLY, ...args], { cwd: root, on, ...(read ? { timeout: 10000 } : {}) });
  },

  // A slow read may finish after the person moved to another repository.
  isCurrent(context) {
    return context === this.contextKey();
  },

  invalidateRepository() {
    const { cwd, on = null } = this.location();
    const root = this.context === this.contextKey() ? this.root : null;
    invalidateWorktreeStatus(root, on);
    const roots = [root, cwd];
    invalidateQueries((key) => {
      try { const k = JSON.parse(key); return k[0]?.startsWith("changes-") && k[1] === on && roots.includes(k[2]); }
      catch { return false; }
    });
  },

  refresh(cx, force = false) {
    if (force) this.invalidateRepository();
    if (!force && window()?.active === false) { this.dirty = true; return; }
    if (!this.visible()) { this.dirty = true; return; }
    if (this.loading || this.busy) return;
    const { cwd, on } = this.location();
    const context = this.contextKey();
    if (context !== this.context) this.startNewContext(context);
    if (!force && !this.dirty && this.retryAt > Date.now()) return;
    // Selection changes still load from follow(); immutable tabs need no poll.
    if (!force && this.mode === "diff" && ["commit", "patch"].includes(this.scope) && this.root) { this.dirty = false; return; }
    this.dirty = false;
    if (!cwd) return;

    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.readRepository(cwd, on, context, cx);
        this.failures = 0;
        this.retryAt = 0;
        this.refreshed = Date.now();
      } catch (error) {
        if (this.isCurrent(context)) {
          this.error = error.message;
          this.failures = (this.failures ?? 0) + 1;
          this.retryAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(this.failures - 1, 4));
        }
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  },

  // Forget everything about the last repository, including diffs still loading.
  startNewContext(context) {
    this.context = context;
    this.retryAt = 0;
    this.failures = 0;
    this.root = null;
    this.files = [];
    this.committed = null;
    this.path = null;
    this.rows = [];
    this.closed = new Set();
    this.diffToken++;
    this.selection = null;
    this.error = null;
    this.note = null;
    this.watched = null;
    this.resetCommits();
    if (this.input) {
      this.message = "";
      this.input.set_value("");
      this.commitMode = "commit";
      this.commitMenuOpen = false;
      this.amendToken++;
      this.amendLoading = false;
      this.amendHead = null;
    }
  },

  async readRepository(cwd, on, context, cx) {
    const root = await resolveGitRoot(cwd, on);
    if (!this.isCurrent(context)) return;
    if (!root) throw new Error("Not a Git repository");
    const git = (args) => this.git(args, root, on);
    if (this.mode === "diff" && ["commit", "patch"].includes(this.scope)) {
      this.root = root;
      this.on = on;
      this.syncSelection(cx);
      if (this.path && !this.diffLoading && !this.rows.length) this.loadDiff(cx);
      return;
    }
    const scan = await readWorktreeStatus(root, on);
    if (!this.isCurrent(context)) return;
    const status = await readStatus(git, scan);
    if (!this.isCurrent(context)) return;
    this.storeStatus(root, on, status);
    this.watch(root, cx);
    if (this.mode === "sidebar") rememberRoot(cwd, root, on);

    if (this.mode === "sidebar") {
      await this.readSidebarState(git, context, cx);
    } else {
      this.syncSelection(cx);
      if (this.path && !this.diffLoading) this.loadDiff(cx);
    }
  },

  storeStatus(root, on, { files, hasHead }) {
    this.root = root;
    this.on = on;
    this.hasHead = hasHead;
    this.total = files.length;
    this.allFiles = files;
    this.files = files.slice(0, this.settings.limits.files);
    this.stagedCount = files.filter((f) => f.staged).length;
    this.conflictPaths = files.filter((f) => f.conflict).map((f) => f.path);
    this.conflicts = this.conflictPaths.length > 0;
    this.error = null;
  },

  async readSidebarState(git, context, cx) {
    const { committed, branch, repo } = await cachedQuery(
      JSON.stringify(["changes-summary", this.on ?? null, this.root, this.settings.limits.files]), 10000,
      async () => ({ committed: await readCommitted(git, this.committed, this.settings.limits.files),
        ...await readBranchAndRepo(git) }));
    if (!this.isCurrent(context)) return;
    this.committed = committed;
    this.branch = branch;
    this.repo = repo;
    if (this.tab === "commit") this.loadCommits(cx);
  },

  // Remote repositories rely on the poll: watchFolder is local only.
  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched !== root) break;
          const observedAt = Date.now();
          const revision = this.watchRevision = (this.watchRevision ?? 0) + 1;
          cx.timer.after(300, (cx) => {
            if (this.watched !== root || revision !== this.watchRevision) return;
            // Hidden/busy panels remember the event and refresh on return.
            this.dirty = true;
            invalidateWorktreeStatus(root, null, observedAt);
            if (this.visible() && window()?.active !== false) this.refresh(cx);
          });
        }
      } catch {
        if (this.watched === root) this.watched = null;
      }
    });
  },

  // ── Stage and unstage ─────────────────────────────────────────────────────

  // Never touches working files. Before the first commit there is no HEAD to
  // reset to. Literal pathspecs keep names such as [a].txt from being patterns.
  // With no path, it acts on the whole repository, including files past the list
  // limit, but never on a conflict: staging one would mark it resolved with its
  // markers still in, and unstaging would throw away Git's record of the conflict.
  indexArgs(action, path) {
    const literal = ["--literal-pathspecs"];
    if (action === "stage") return [...literal, "add", "--", path];
    if (this.hasHead) return [...literal, "reset", "-q", "HEAD", "--", path];
    return [...literal, "rm", "--cached", "-r", "-f", "--", path];
  },

  // The commands for Stage all or Unstage all. Git's exclude pathspecs don't stop
  // `add -A` from resolving a conflict, so during a merge they name each file.
  bulkIndexCommands(action) {
    const stage = action === "stage";
    if (!this.conflicts) {
      if (stage) return [["add", "-A"]];
      if (this.hasHead) return [["--literal-pathspecs", "reset", "-q", "HEAD", "--", "."]];
      return [["--literal-pathspecs", "rm", "--cached", "-r", "-f", "--", "."]];
    }
    const wanted = this.allFiles.filter((f) => !f.conflict && (stage ? f.unstaged : f.staged));
    const commands = [];
    for (let i = 0; i < wanted.length; i += BULK_PATHS) {
      const paths = wanted.slice(i, i + BULK_PATHS).map((f) => f.path);
      commands.push(
        stage
          ? ["--literal-pathspecs", "add", "--", ...paths]
          : ["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...paths],
      );
    }
    return commands;
  },

  indexAction(action, path, cx) {
    if (!this.root || this.busy || this.contextKey() !== this.context) return;
    const commands = path ? [this.indexArgs(action, path)] : this.bulkIndexCommands(action);
    const root = this.root;
    const on = this.on;
    this.busy = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        for (const args of commands) {
          const result = await this.git(args, root, on);
          if (result.code !== 0) throw Error((result.stderr || result.stdout).trim());
        }
        this.reload = Date.now();
        setShared("xmux-changes.reload", { root, on: on ?? null, at: this.reload });
      } catch (error) {
        this.note = `${action === "stage" ? "Stage" : "Unstage"} failed: ${error.message}`;
      } finally {
        this.busy = false;
        this.refresh(cx, true);
        cx.notify();
      }
    });
  },

  // ── History ───────────────────────────────────────────────────────────────

  resetCommits() {
    this.commits = [];
    this.remoteHead = null;
    this.behind = 0;
    this.commitsDone = false;
    this.commitsLoading = false;
    this.commitsError = null;
    this.selectedCommit = null;
    this.commitFiles = [];
    this.commitFilesLoading = false;
    this.commitFilesError = null;
    this.commitsToken = (this.commitsToken ?? 0) + 1;
    this.commitToken = (this.commitToken ?? 0) + 1;
  },

  // `more` appends the next page; otherwise this reloads the pages already shown.
  loadCommits(cx, more = false) {
    if (this.commitsLoading || !this.root) return;
    if (!this.hasHead) {
      this.commitsDone = true;
      return;
    }
    const context = this.context;
    const token = ++this.commitsToken;
    const isStale = () => token !== this.commitsToken || !this.isCurrent(context);
    const pageSize = this.settings.limits.commits_per_page;
    const count = more ? pageSize : Math.max(pageSize, this.commits.length);
    const skip = more ? this.commits.length : 0;
    const git = (args) => this.git(args);

    this.commitsLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const page = await readLog(git, count, skip);
        if (isStale()) return;
        if (!more) {
          const behind = await readBehind(git, this.committed);
          const remoteHead = await readRemoteHead(git, this.committed);
          if (isStale()) return;
          this.behind = behind;
          this.remoteHead = remoteHead;
        }
        this.commits = more ? [...this.commits, ...page] : page;
        this.commitsDone = page.length < count;
        this.commitsError = null;
      } catch (error) {
        if (token === this.commitsToken) this.commitsError = error.message;
      } finally {
        if (token === this.commitsToken) {
          this.commitsLoading = false;
          cx.notify();
        }
      }
    });
  },

  // ── Commit and amend ──────────────────────────────────────────────────────

  setCommitMode(mode, cx) {
    if (
      !this.input ||
      !this.root ||
      this.busy ||
      this.contextKey() !== this.context ||
      (mode === "amend" && !this.hasHead)
    )
      return;
    // Leaving Amend takes back the message it loaded, unless it was edited.
    if (mode === "commit" && this.amendLoaded && this.message === this.amendLoaded) {
      this.message = "";
      this.input.set_value("");
    }
    this.amendLoaded = null;
    this.commitMode = mode;
    this.commitMenuOpen = false;
    this.note = null;
    this.amendHead = null;
    const token = ++this.amendToken;
    this.amendLoading = mode === "amend";
    cx.notify();
    if (mode !== "amend") return;
    const { context, root, on } = this;
    const revision = this.messageRevision;
    cx.spawn(async (cx) => {
      try {
        const result = await this.git(["log", "-1", "--format=%H%x00%B"], root, on);
        if (token !== this.amendToken || !this.isCurrent(context)) return;
        if (result.code !== 0) throw Error((result.stderr || result.stdout).trim());
        const separator = result.stdout.indexOf("\0");
        const head = result.stdout.slice(0, separator);
        if (separator < 0 || !/^[0-9a-f]{40,64}$/i.test(head))
          throw Error("Cannot read the latest commit.");
        this.amendHead = head;
        // Never replace a draft, or one edited while this read was running.
        if (!this.message.trim() && this.messageRevision === revision) {
          this.message = result.stdout.slice(separator + 1).trimEnd();
          this.input.set_value(this.message);
          this.amendLoaded = this.message;
        }
      } catch (error) {
        if (token === this.amendToken && this.isCurrent(context))
          this.note = `Cannot prepare amend: ${error.message}`;
      } finally {
        if (token === this.amendToken) {
          this.amendLoading = false;
          cx.notify();
        }
      }
    });
  },

  canCommit() {
    if (
      !this.input ||
      !this.message.trim() ||
      !this.root ||
      this.busy ||
      this.loading ||
      this.conflicts ||
      this.contextKey() !== this.context
    )
      return false;
    // A message-only amend is valid; a new commit needs something staged.
    return Boolean(
      this.commitMode === "amend"
        ? this.hasHead && this.amendHead && !this.amendLoading
        : this.stagedCount,
    );
  },

  // Both use the index as it is, never `-a`. A failure keeps the draft, and a
  // success keeps anything typed while it ran.
  commit(cx) {
    if (!this.canCommit()) return;
    const { root, on, context } = this;
    const draft = this.message;
    const amend = this.commitMode === "amend";
    const expected = this.amendHead;
    this.busy = true;
    this.operation = amend ? "amend" : "commit";
    this.commitMenuOpen = false;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (amend) {
          // Another tool may have moved HEAD since Amend was chosen.
          const head = await this.git(["rev-parse", "--verify", "HEAD"], root, on);
          if (head.code !== 0 || head.stdout.trim() !== expected)
            throw Error("The latest commit changed. Choose Amend again before retrying.");
        }
        const result = await this.git(
          ["commit", ...(amend ? ["--amend"] : []), "-m", draft.trim()],
          root,
          on,
        );
        if (result.code !== 0) throw Error((result.stderr || result.stdout).trim());
        this.reload = Date.now();
        setShared("xmux-changes.reload", { root, on: on ?? null, at: this.reload });
        if (this.isCurrent(context)) {
          if (this.message === draft) {
            this.message = "";
            this.input.set_value("");
          }
          this.commitMode = "commit";
          this.amendHead = null;
        }
      } catch (error) {
        if (this.isCurrent(context))
          this.note = `${amend ? "Amend" : "Commit"} failed: ${error.message}`;
      } finally {
        this.busy = false;
        this.operation = null;
        this.refresh(cx, true);
        cx.notify();
      }
    });
  },

  openCommit(commit, cx) {
    const context = this.context;
    const root = this.root, on = this.on;
    const token = ++this.commitToken;
    this.selectedCommit = commit;
    this.commitFiles = [];
    this.commitFilesError = null;
    this.commitFilesLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const files = await cachedQuery(JSON.stringify(["changes-commit-files", on ?? null, root, commit.hash]),
          1800000, () => readCommitFiles((args) => this.git(args, root, on), commit.hash));
        if (token !== this.commitToken || !this.isCurrent(context)) return;
        this.commitFiles = files;
      } catch (error) {
        if (token === this.commitToken) this.commitFilesError = error.message;
      } finally {
        if (token === this.commitToken) {
          this.commitFilesLoading = false;
          cx.notify();
        }
      }
    });
  },
};

// Which issues this copy is looking at, following the space, its checkout and its
// branch. A token per kind of read lets an old answer finish without replacing
// what's on screen after navigation.
import { exec } from "herdr";
import { cachedQuery } from "../shared/query-cache.js";
import { rememberRoot } from "../shared/context.js";
import { identifiersIn, searchQuery } from "./model.js";
import { resolveProvider } from "../shared/provider.js";

// A branch name rarely carries more identifiers than this; each one costs a request.
const MAX_BRANCH_CANDIDATES = 4;

export const discoveryMethods = {
  // Everything below resets when the space, folder or branch changes.
  changeSpace(sp, key, cx) {
    this.rememberView();
    this.restoreSelection = null;
    this.lastUpdated = null;
    // Invalidate in-flight requests before clearing space-specific state.
    this.spaceKey = key;
    this.sp = sp;
    this.providerToken = (this.providerToken ?? 0) + 1;
    this.providerLoading = false;
    this.me = null;
    this.listToken++;
    this.detailToken++;
    this.branchToken++;
    this.searchToken++;
    this.branchLoading = false;
    this.searchPending = false;
    this.serverSearch = searchQuery(this.search.value());
    this.branch = null;
    this.branchIssues = [];
    this.linkedIdentifiers = new Set();
    this.listLoaded = false;
    this.branchLoaded = false;
    this.contextSince = Date.now();
    this.notice = null;
    this.issue = null;
    this.opening = null;
    this.items = [];
    this.cursor = "";
    this.error = null;
    this.provider = null;
    this.loading = false;
    this.detailLoading = false;
    this.worktreeForm = null;
    this.worktrees = null;
    this.composer = null;
    this.draftKey = null;
    this.section = "overview";
    if (!sp?.folder) {
      this.listLoaded = true;
      this.branchLoaded = true;
      cx.notify();
      return;
    }
    this.restoreView();
    this.resolveProvider(cx);
  },

  async detectProvider(sp) {
    return cachedQuery(JSON.stringify(["issue-provider:v2", sp.machine ?? null, sp.folder, this.settings.tools ?? null]), 300000, async () => {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: sp.folder, on: sp.machine, timeout: 5000 });
      if (top.code === 0) rememberRoot(sp.folder, top.stdout.trim(), sp.machine);
      const options = { cwd: sp.folder, on: sp.machine, timeout: 5000, tools: this.settings.tools };
      let lastError;
      const tried = new Set();
      for (const name of ["upstream", "origin"]) {
        tried.add(name);
        const result = await exec("git", ["remote", "get-url", name], options);
        if (result.code === 0) {
          try {
            return await resolveProvider(result.stdout, options);
          } catch (error) {
            lastError = error;
            // Try the next configured remote before reporting that none is usable.
          }
        }
      }
      const remotes = await exec("git", ["remote"], options);
      for (const name of (remotes.stdout || "").split(/\r?\n/).filter(Boolean)) {
        if (tried.has(name)) continue;
        const result = await exec("git", ["remote", "get-url", name], options);
        try {
          return await resolveProvider(result.stdout, options);
        } catch (error) {
          lastError = error;
          // Try the next configured remote before reporting that none is usable.
        }
      }
      throw lastError ?? new Error("No GitHub or GitLab remote found for this directory.");
    }, { share: true });
  },

  resolveProvider(cx) {
    if (!this.sp?.folder || this.providerLoading) return;
    const token = ++this.providerToken;
    const sp = this.sp;
    this.providerLoading = true;
    cx.spawn(async (cx) => {
      try {
        const provider = await this.detectProvider(sp);
        if (token !== this.providerToken) return;
        this.provider = provider;
        this.providerLoading = false;
        this.refresh(cx);
      } catch (e) {
        if (token === this.providerToken) {
          this.error = e.message;
          this.listLoaded = true;
          this.branchLoaded = true;
          this.refreshed = Date.now();
        }
      } finally {
        if (token === this.providerToken) { this.providerLoading = false; cx.notify(); }
      }
    });
  },

  soleBranchIssue() {
    return this.view === "branch" && this.branchIssues.length === 1 ? this.branchIssues[0] : null;
  },

  // A branch with one issue has nothing to choose from, so its details are the view.
  openSoleBranchIssue(cx) {
    const sole = this.soleBranchIssue();
    if (!sole || this.issue || this.opening || this.detailLoading) return;
    this.opening = { identifier: sole.identifier };
    this.openIssue(sole.identifier, cx);
  },

  // The branch's issues: an explicit `branch.<name>.herdr-issue` binding first, then
  // identifiers in the branch name. GitHub/GitLab confirms each; the rest are dropped.
  loadBranchIssues(cx) {
    if (!this.sp?.folder || this.mutating || this.branchLoading) return;
    const token = ++this.branchToken;
    const sp = this.sp;
    const key = this.spaceKey;
    this.branchLoading = true;
    cx.spawn(async (cx) => {
      try {
        const options = { cwd: sp.folder, on: sp.machine, timeout: 5000, tools: this.settings.tools };
        const result = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], options);
        if (token !== this.branchToken || key !== this.spaceKey) return;
        this.branch = result.code === 0 ? result.stdout.trim() : "";
        if (!this.branch) {
          this.branchIssues = [];
          return;
        }
        const binding = await exec(
          "git",
          ["config", "--get", `branch.${this.branch}.herdr-issue`],
          options,
        );
        if (token !== this.branchToken || key !== this.spaceKey) return;
        const provider = this.provider;
        const bound = identifiersIn(binding.stdout ?? "");
        const named = identifiersIn(this.branch);
        const limit = Math.max(
          bound.length,
          this.settings.branch.max_identifiers || MAX_BRANCH_CANDIDATES,
        );
        const candidates = [...new Set([...bound, ...named])].slice(0, limit);
        const results = await Promise.allSettled(candidates.map((identifier) =>
          this.api({ action: "detail", identifier, repo: provider.repo, provider }, sp)));
        const found = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
        if (token !== this.branchToken || key !== this.spaceKey) return;
        this.branchIssues = found;
        // Only a binding can be undone; an identifier in the branch name would come back.
        this.linkedIdentifiers = new Set(bound.filter((id) => !named.includes(id)));
      } catch (e) {
        if (token === this.branchToken) this.error = e.message;
      } finally {
        if (token === this.branchToken) {
          this.branchLoading = false;
          this.branchLoaded = true;
          this.refreshed = Date.now();
          this.openSoleBranchIssue(cx);
          cx.notify();
        }
      }
    });
  },

  // Bind an issue to the branch by hand. The binding is a comma-separated list, so a
  // branch can carry several.
  linkIssue(cx) {
    const identifier = identifiersIn(this.linkInput.value())[0];
    if (!identifier || !this.branch || this.mutating) return;
    const sp = this.sp;
    const key = `branch.${this.branch}.herdr-issue`;
    this.mutating = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.api({ action: "detail", identifier }, sp);
        const options = { cwd: sp.folder, on: sp.machine, timeout: 5000, tools: this.settings.tools };
        const current = await exec("git", ["config", "--get", key], options);
        const list = [...new Set([...identifiersIn(current.stdout ?? ""), identifier])].join(",");
        const written = await exec("git", ["config", key, list], options);
        if (written.code !== 0)
          throw new Error(written.stderr?.trim() || "Could not write the branch binding.");
        this.linkInput.set_value("");
        this.mutating = false;
        this.loadBranchIssues(cx);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.mutating = false;
        cx.notify();
      }
    });
  },

  // Remove a hand-made binding. The git config key is dropped when it empties.
  unlinkIssue(identifier, cx) {
    if (!this.branch || this.mutating) return;
    const sp = this.sp;
    const key = `branch.${this.branch}.herdr-issue`;
    this.mutating = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const options = { cwd: sp.folder, on: sp.machine, timeout: 5000, tools: this.settings.tools };
        const current = await exec("git", ["config", "--get", key], options);
        const rest = identifiersIn(current.stdout ?? "").filter((id) => id !== identifier);
        const written = await exec(
          "git",
          rest.length ? ["config", key, rest.join(",")] : ["config", "--unset", key],
          options,
        );
        if (written.code !== 0)
          throw new Error(written.stderr?.trim() || "Could not update the branch binding.");
        this.issue = null;
        this.mutating = false;
        this.loadBranchIssues(cx);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.mutating = false;
        cx.notify();
      }
    });
  },
};

// Which repository and PR this copy is looking at, following the space, its
// checkout and its branch. A token per kind of read lets an old answer finish
// without replacing what's on screen after navigation.
import { exec } from "herdr";
import { cachedQuery } from "../shared/query-cache.js";
import { rememberRoot } from "../shared/context.js";
import { repositoryFromRemote, searchQuery } from "./model.js";
import { resolveProvider, decodeBinding, requestKey, repositoryKey } from "./provider.js";

export const discoveryMethods = {
  changeSpace(sp, key, cx) {
    this.leavePR();
    this.rememberView();
    this.browseKey = null;
    this.restoreSelection = null;
    this.pendingPR = null;
    this.lastUpdated = null;
    // Invalidate in-flight requests before clearing repository-specific state.
    this.spaceKey = key;
    this.sp = sp;
    this.loadNewAgents(sp, cx);
    this.listToken++;
    this.detailToken++;
    this.repoToken++;
    this.branchToken++;
    this.searchToken++;
    this.repoLoading = false;
    this.branchLoading = false;
    this.searchPending = false;
    this.searchReloadNeeded = false;
    this.serverSearch = searchQuery(this.search.value());
    this.branch = null;
    this.branchPRs = [];
    this.listLoaded = false;
    this.branchLoaded = false;
    this.contextSince = Date.now();
    this.remotes = [];
    this.remote = "";
    this.provider = null;
    this.notice = null;
    this.repo = "";
    this.pr = null;
    this.items = [];
    this.error = null;
    this.loading = false;
    this.detailLoading = false;
    this.worktreeForm = null;
    this.composer = null;
    this.draftKey = null;
    this.jobs = {};
    this.logs = {};
    this.prFiles = null;
    this.sectionLoads = {};
    this.stateChange = null;
    this.section = "overview";
    if (!sp?.folder) {
      this.listLoaded = true;
      this.branchLoaded = true;
      cx.notify();
      return;
    }
    this.refresh(cx);
  },

  async detectRepo(sp) {
    return cachedQuery(JSON.stringify(["detect-repo:v2", sp.machine ?? null, sp.folder, this.settings.tools ?? null, this.settings.hosts ?? []]), 300000, async () => {
      const options = { cwd: sp.folder, on: sp.machine, timeout: 5000, tools: this.settings.tools, hosts: this.settings.hosts };
      const remote = (name) => exec("git", ["remote", "get-url", name], options);
      let result = await remote("upstream");
      if (result.code !== 0) {
        const branch = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], options);
        if (branch.code === 0) {
          const tracking = await exec(
            "git",
            ["config", "--get", `branch.${branch.stdout.trim()}.remote`],
            options,
          );
          if (tracking.code === 0 && tracking.stdout.trim() !== ".")
            result = await remote(tracking.stdout.trim());
        }
        if (result.code !== 0) result = await remote("origin");
      }
      if (result.code !== 0) throw new Error("No GitHub or GitLab remote found for this directory.");
      return resolveProvider(result.stdout, options);
    }, { share: true });
  },

  soleBranchPR() {
    return this.view === "branch" && this.branchPRs.length === 1 ? this.branchPRs[0] : null;
  },

  // A branch with one PR has nothing to choose from, so its details are the view.
  openSoleBranchPR(cx) {
    const sole = this.soleBranchPR();
    if (!sole || this.pr || this.opening || this.detailLoading) return;
    this.opening = { number: sole.number, provider: sole.provider };
    this.openPR(sole.number, cx, sole.repository ?? this.repo, sole.provider);
  },

  // The PRs from this checkout's branch. A worktree made for a PR records its exact
  // association, which beats searching by branch name, ambiguous across forks.
  loadBranchPRs(cx) {
    if (!this.sp?.folder || this.mutating || this.branchLoading) return;
    const token = ++this.branchToken;
    const sp = this.sp;
    const key = this.spaceKey;
    const options = { cwd: sp.folder, on: sp.machine, timeout: 5000, tools: this.settings.tools, hosts: this.settings.hosts };
    this.branchLoading = true;
    cx.spawn(async (cx) => {
      try {
        const result = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], options);
        if (token !== this.branchToken || key !== this.spaceKey) return;
        this.branch = result.code === 0 ? result.stdout.trim() : "";
        if (!this.branch) {
          this.branchPRs = [];
          return;
        }
        const binding = await exec(
          "git",
          ["config", "--get", `branch.${this.branch}.herdr-pr`],
          options,
        );
        if (token !== this.branchToken || key !== this.spaceKey) return;
        const association = decodeBinding(binding.stdout?.trim());
        if (association) {
          const linked = await this.api({ action: "detail", repo: association.repo,
            number: association.number, provider: association.provider }, sp);
          if (token !== this.branchToken || key !== this.spaceKey) return;
          this.branchPRs = [linked];
          return;
        }
        const remotes = await this.discoverRemotes(sp);
        if (token !== this.branchToken || key !== this.spaceKey) return;
        const repositories = [...new Map(remotes.filter(r => r.repo).map(r =>
          [repositoryKey({ kind: r.provider, host: r.host }, r.repo), r])).values()];
        const results = await Promise.allSettled(
          repositories.map(remote => this.api({ action: "branch", repo: remote.repo,
            provider: { kind: remote.provider, host: remote.host }, branch: this.branch }, sp)),
        );
        if (token !== this.branchToken || key !== this.spaceKey) return;
        const failures = results.filter(r => r.status === "rejected");
        // Same-named branches in other forks must not attach to this checkout.
        const ours = new Set(repositories.map(r => repositoryKey({ kind: r.provider, host: r.host }, r.repo).toLowerCase()));
        const matches = results.filter(r => r.status === "fulfilled").flatMap(r => r.value.items)
          .filter(p => p.headRefName === this.branch && ours.has(repositoryKey(p.provider, p.headRepository?.nameWithOwner).toLowerCase()));
        this.branchPRs = [...new Map(matches.map((p) => [requestKey(p), p])).values()].sort(
          (a, b) =>
            (b.state === "OPEN") - (a.state === "OPEN") || b.updatedAt.localeCompare(a.updatedAt),
        );
        const warnings = results.filter(r => r.status === "fulfilled").map(r => r.value.warning).filter(Boolean);
        if (warnings.length) this.notice = warnings.join(" ");
        if (failures.length) {
          this.notice = `${failures.length} remote repositories could not be checked.`;
          if (!this.branchPRs.length) this.error = failures[0].reason.message;
        }
      } catch (e) {
        if (token === this.branchToken) this.error = e.message;
      } finally {
        if (token === this.branchToken) {
          this.branchLoading = false;
          this.branchLoaded = true;
          this.refreshed = Date.now();
          this.openSoleBranchPR(cx);
          cx.notify();
        }
      }
    });
  },

  remotePreferenceKey() {
    return `pr-remote:${this.sp?.machine ?? "local"}:${this.sp?.folder ?? ""}`;
  },

  async discoverRemotes(sp) {
    return cachedQuery(JSON.stringify(["remotes:v2", sp.machine ?? null, sp.folder, this.settings.tools ?? null, this.settings.hosts ?? []]), 300000, async () => {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: sp.folder, on: sp.machine, timeout: 5000 });
      if (top.code === 0) rememberRoot(sp.folder, top.stdout.trim(), sp.machine);
      const options = { cwd: sp.folder, on: sp.machine, timeout: 5000, tools: this.settings.tools, hosts: this.settings.hosts };
      const result = await exec("git", ["remote"], options);
      if (result.code !== 0) throw new Error("Cannot read Git remotes for this directory.");
      const names = [...new Set(result.stdout.trim().split(/\r?\n/).filter(Boolean))].sort();
      let lastError;
      const entries = await Promise.all(
        names.map(async (name) => {
          const url = await exec("git", ["remote", "get-url", name], options);
          try {
            if (url.code !== 0) throw new Error("Unavailable");
            const provider = await resolveProvider(url.stdout, options);
            return { name, repo: provider.repo, provider: provider.kind, host: provider.host };
          } catch (error) {
            lastError = error;
            return { name, repo: null };
          }
        }),
      );
      if (!entries.some((entry) => entry.repo))
        throw lastError ?? new Error("No GitHub or GitLab remote found for this directory.");
      return entries;
    }, { share: true });
  },

  chooseRemote(name, cx) {
    const selected = this.remotes.find((r) => r.name === name && r.repo);
    if (!selected || this.mutating) return;
    localStorage.setItem(this.remotePreferenceKey(), name);
    this.leavePR();
    this.rememberView();
    this.repoToken++;
    this.listToken++;
    this.detailToken++;
    this.searchToken++;
    this.repoLoading = false;
    this.detailLoading = false;
    this.remote = name;
    this.repo = selected.repo;
    this.provider = { kind: selected.provider, host: selected.host };
    this.pr = this.opening = this.pendingPR = this.composer = this.stateChange = this.worktreeForm = null;
    this.draftKey = this.commentKey = null;
    this.jobs = {};
    this.logs = {};
    this.sectionLoads = {};
    this.prFiles = null;
    this.items = [];
    this.listLoaded = false;
    this.notice = this.error = null;
    this.restoreView(this.repo);
    this.loadList(cx);
    cx.notify();
  },

  resolveRepo(cx) {
    if (this.repoLoading) return;
    if (!this.sp?.folder) return;
    const token = ++this.repoToken;
    const key = this.spaceKey;
    const sp = this.sp;
    this.repoLoading = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const [remotes, defaultProvider] = await Promise.all([
          this.discoverRemotes(sp),
          this.detectRepo(sp).catch(() => null),
        ]);
        if (token !== this.repoToken || key !== this.spaceKey) return;
        this.remotes = remotes;
        const preference = localStorage.getItem(this.remotePreferenceKey());
        const selected =
          remotes.find((r) => r.name === preference && r.repo) ??
          remotes.find((r) => r.name === "upstream" && r.repo === defaultProvider?.repo && r.provider === defaultProvider?.kind && r.host === defaultProvider?.host) ??
          remotes.find((r) => r.repo && r.repo === defaultProvider?.repo && r.provider === defaultProvider?.kind && r.host === defaultProvider?.host) ??
          remotes.find((r) => r.repo);
        if (!selected) throw new Error("No GitHub or GitLab remote found for this directory.");
        if (preference && !remotes.some((r) => r.name === preference && r.repo))
          localStorage.removeItem(this.remotePreferenceKey());
        this.remote = selected.name;
        const repo = selected.repo;
        this.provider = { kind: selected.provider, host: selected.host };
        this.restoreView(repo);
        if (repo !== this.repo) {
          this.repo = repo;
          this.items = [];
          this.listToken++;
        }
        // Only what's on screen, to spare API quota, plus once for the tab's count.
        if (this.view === "all" || !this.listLoaded) this.loadList(cx);
      } catch (e) {
        if (token === this.repoToken && key === this.spaceKey) {
          this.listToken++;
          this.loading = false;
          this.repo = "";
          this.items = [];
          this.listLoaded = true;
          this.error = e.message;
          this.refreshed = Date.now();
        }
      } finally {
        if (token === this.repoToken) {
          this.repoLoading = false;
          cx.notify();
        }
      }
    });
  },
};

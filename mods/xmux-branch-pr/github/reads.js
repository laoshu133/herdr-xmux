// Provider-neutral reads. UI state always belongs to a complete repository identity.
import { duration, size } from "../settings.js";
import { runIdOf, searchQuery } from "./model.js";
import { requestKey } from "./provider.js";
import { gitlabApi } from "../gitlab/cli.js";
import { githubApi } from "./cli.js";
import { cachedQuery, invalidateQueries, peekQuery, queryKey } from "../shared/query-cache.js";

const SEARCH_DEBOUNCE_MS = 450;
const LOG_TAIL_BYTES = 60000;
const READS = ["list", "detail", "branch", "files", "jobs", "logs", "viewer", "conversation", "checks"];

export const readMethods = {
  searchChanged(cx) {
    const token = ++this.searchToken;
    this.rememberView();
    this.searchReloadNeeded = Boolean(this.searchReloadNeeded || this.loading);
    this.listToken++;
    this.searchPending = true;
    this.loading = false;
    cx.timer.after(duration(this.settings.refresh.search_debounce, SEARCH_DEBOUNCE_MS), (cx) => {
      if (token !== this.searchToken) return;
      const query = searchQuery(this.search.value());
      this.searchPending = false;
      if (this.searchReloadNeeded || query !== (this.serverSearch ?? "") || this.filterChanged) {
        this.filterChanged = false;
        this.serverSearch = query;
        this.loadList(cx);
      }
      cx.notify();
    });
    cx.notify();
  },

  apiKey(request, sp = this.sp) {
    const provider = request.provider ?? this.provider;
    const { provider: _provider, tools: _tools, pr: _pr, ...payload } = request;
    return queryKey(["pr-api", sp?.machine ?? null, provider?.kind, provider?.host,
      this.settings.tools ?? null, { ...payload, repo: request.repo ?? provider?.repo ?? this.repo }]);
  },

  async api(request, sp = this.sp) {
    const provider = request.provider ?? this.provider;
    if (!provider?.kind || !provider?.host) throw new Error("Select a GitHub or GitLab repository first.");
    request = { tools: this.settings.tools, ...request, provider, repo: request.repo ?? provider.repo ?? this.repo };
    const read = READS.includes(request.action);
    const load = async () => {
      const data = await (provider.kind === "gitlab" ? gitlabApi : githubApi)(request, sp, provider);
      const stamp = (item) => ({ ...item, provider, repository: item.repository || request.repo });
      if (request.action === "detail") return stamp(data);
      if (["list", "branch"].includes(request.action)) return { ...data, items: data.items.map(stamp) };
      return data;
    };
    if (!read) {
      try { return await load(); }
      finally {
        // A timeout may follow a successful write. Reconcile before retrying.
        invalidateQueries((key) => {
          try { const k = JSON.parse(key); return k[0] === "pr-api" && k[2] === provider.kind && k[3] === provider.host && k[5]?.repo === request.repo; }
          catch { return false; }
        });
        this.cache = {};
      }
    }
    const ttl = ["detail", "jobs", "checks", "conversation", "logs"].includes(request.action) ? 30000
      : request.action === "files" && request.version ? 3600000 : 60000;
    return cachedQuery(this.apiKey(request, sp), ttl, load);
  },

  listKey() {
    return JSON.stringify([this.sp?.machine, this.provider?.kind, this.provider?.host, this.repo, this.tab, this.state, this.serverSearch ?? "", this.listAuthor?.value() ?? "", this.listReviewer?.value() ?? ""]);
  },

  loadList(cx, more = false) {
    if (!this.repo) return;
    this.searchReloadNeeded = false;
    this.rememberView();
    const token = ++this.listToken;
    const key = this.listKey();
    this.loading = true;
    this.error = null;
    const keep = !more && this.cache[key]?.items === this.items && this.items.length > this.settings.list.page_size;
    if (!more && !keep) {
      const cached = this.cache[key];
      this.items = cached?.items ?? [];
      this.cursors = cached?.cursors ?? {};
      this.total = cached?.total ?? null;
    }
    const request = { action: "list", repo: this.repo, provider: this.provider, tab: this.tab, state: this.state,
      search: this.serverSearch ?? "", author: this.listAuthor.value().trim(), reviewer: this.listReviewer.value().trim(), cursors: more ? this.cursors : {}, pageSize: this.settings.list.page_size };
    cx.spawn(async (cx) => {
      try {
        const data = await this.api(request);
        if (token !== this.listToken) return;
        const merged = new Map((more || keep ? this.items : []).map(p => [requestKey(p), p]));
        for (const p of data.items) merged.set(requestKey(p), p);
        this.items = [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (!keep) this.cursors = data.cursors ?? {};
        this.total = data.total ?? null;
        if (Object.keys(this.cache).length > 64) delete this.cache[Object.keys(this.cache)[0]];
        this.cache[key] = { items: this.items, cursors: this.cursors, total: this.total };
        this.refreshed = this.lastUpdated = Date.now();
        const restore = this.reopenSaved ? this.restoreSelection : null;
        this.reopenSaved = false;
        this.restoreSelection = null;
        if (restore && !this.pr) this.openPR(restore.number, cx, restore.repository ?? this.repo, restore.provider ?? this.provider);
        else this.rememberView();
      } catch (e) {
        if (token === this.listToken) { this.error = e.message; this.refreshed = Date.now(); }
      } finally {
        if (token === this.listToken) { this.loading = false; this.listLoaded = true; cx.notify(); }
      }
    });
  },

  openPR(number, cx, repo = this.repo, provider = this.provider) {
    this.pendingPR = { number, repository: repo, provider };
    const token = ++this.detailToken;
    const key = this.spaceKey;
    const request = { action: "detail", repo, number, provider };
    const cached = peekQuery(this.apiKey(request));
    if (cached) this.adoptPR(cached, repo);
    this.detailLoading = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const pr = await this.api(request);
        if (token !== this.detailToken || key !== this.spaceKey) return;
        this.pendingPR = null;
        this.adoptPR(pr, repo);
        this.refreshed = Date.now();
        this.loadWorktrees(cx);
        if (this.section === "files") this.loadFiles(cx);
        else this.loadSection(this.section, cx);
      } catch (e) {
        if (token === this.detailToken && key === this.spaceKey) { this.error = e.message; this.refreshed = Date.now(); }
      } finally {
        if (token === this.detailToken) { this.detailLoading = false; this.opening = null; cx.notify(); }
      }
    });
  },

  loadSection(section, cx) {
    const pr = this.pr;
    if (!pr || pr.provider?.kind !== "gitlab" || !["checks", "conversation"].includes(section)) return;
    const key = `${this.spaceKey}:${requestKey(pr)}:${pr.headRefOid}`;
    this.sectionLoads ??= {};
    if (this.sectionLoads[section]?.key === key && this.sectionLoads[section]?.loading) return;
    this.sectionLoads[section] = { key, loading: true };
    cx.spawn(async (cx) => {
      try {
        const data = await this.api({ action: section, repo: pr.repository, number: pr.number, provider: pr.provider, pr, version: pr.headRefOid });
        if (this.sectionLoads[section]?.key !== key || `${this.spaceKey}:${requestKey(this.pr)}:${this.pr?.headRefOid}` !== key) return;
        this.pr = { ...this.pr, ...data, loaded: { ...this.pr.loaded, [section]: true } };
        this.sectionLoads[section] = { key };
        this.adoptPR(this.pr, pr.repository);
      } catch (e) {
        if (this.sectionLoads[section]?.key === key) this.sectionLoads[section] = { key, error: e.message };
      }
      cx.notify();
    });
  },

  refresh(cx, force = false) {
    if (force) {
      invalidateQueries(key => /pr-api|pr-meta|provider|remotes|detect-repo/.test(key));
      this.prFiles = null;
      this.jobs = {};
      this.logs = {};
      this.checkOpen = {};
      this.sectionLoads = {};
    }
    this.refreshed = Date.now();
    this.loadBranchPRs(cx);
    this.resolveRepo(cx);
    if (this.pr) this.openPR(this.pr.number, cx, this.pr.repository, this.pr.provider);
  },

  loadJobs(check, cx) {
    const id = runIdOf(check), pr = this.pr;
    if (!id || !pr) return;
    const key = requestKey(pr);
    this.jobs[id] = { loading: true };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const pages = await this.api({ action: "jobs", repo: pr.repository, number: pr.number, provider: pr.provider, run: Number(id), projectId: check.projectId });
        if (key === requestKey(this.pr)) this.jobs[id] = { jobs: pages.flatMap(p => p.jobs ?? []), warning: pages.find(p => p.warning)?.warning };
      } catch (e) { if (key === requestKey(this.pr)) this.jobs[id] = { error: e.message }; }
      cx.notify();
    });
  },

  loadLogs(job, cx) {
    const pr = this.pr;
    if (!pr) return;
    const key = requestKey(pr);
    this.logs[job.id] = { loading: true };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const data = await this.api({ action: "logs", repo: pr.repository, provider: pr.provider, job: job.id, projectId: job.projectId,
          tail: size(this.settings.logs.keep_last, LOG_TAIL_BYTES) });
        if (key === requestKey(this.pr)) this.logs[job.id] = data;
      } catch (e) { if (key === requestKey(this.pr)) this.logs[job.id] = { error: e.message }; }
      cx.notify();
    });
  },
};

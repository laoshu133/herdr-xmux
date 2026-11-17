// What survives a reload: each repository's filters and open PR, each PR's tab
// and filters, and which comments have been read.
import { requestKey, repositoryKey } from "../github/provider.js";
import { allComments, searchQuery } from "../github/model.js";

const SECTIONS = ["overview", "conversation", "checks", "files"];

export const savedMethods = {
  readStored(key, fallback = {}) {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? "null");
      return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
    } catch {
      return fallback;
    }
  },

  readStoredList(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  },

  viewKey(repo = this.repo) {
    return `pr-view:v3:${this.sp?.machine ?? "local"}:${this.sp?.folder ?? ""}:${repositoryKey(this.provider, repo)}`;
  },

  detailKey(pr = this.pr) {
    return `pr-detail:v2:${this.sp?.machine ?? "local"}:${this.sp?.folder ?? ""}:${requestKey(pr)}`;
  },

  rememberDetail() {
    if (!this.pr) return;
    localStorage.setItem(
      this.detailKey(),
      JSON.stringify({
        section: this.section,
        author: this.author,
        unresolved: Boolean(this.unresolved),
        workflowOpen: this.workflowOpen,
        checkOpen: this.checkOpen,
      }),
    );
  },

  rememberView() {
    this.rememberDetail();
    if (!this.browseKey) return;
    localStorage.setItem(
      this.browseKey,
      JSON.stringify({
        tab: this.tab,
        state: this.state,
        query: this.search.value(),
        listAuthor: this.listAuthor.value(),
        listReviewer: this.listReviewer.value(),
        selected: this.pr
          ? { number: this.pr.number, repository: this.pr.repository, provider: this.pr.provider }
          : (this.pendingPR ?? this.restoreSelection ?? null),
        lastUpdated: this.lastUpdated || null,
      }),
    );
  },

  restoreView(repo) {
    const key = this.viewKey(repo);
    if (key === this.browseKey) return;
    this.rememberView();
    this.browseKey = key;
    const saved = this.readStored(key);
    this.viewWasSaved = Boolean(saved.tab || saved.state);
    const tabs = ["all", "mine", "review-requested"];
    const states = ["open", "draft", "merged", "closed", "all"];
    const wanted = this.settings.list.default;
    this.tab = tabs.includes(saved.tab)
      ? saved.tab
      : tabs.includes(wanted.tab)
        ? wanted.tab
        : "all";
    this.state = states.includes(saved.state)
      ? saved.state
      : states.includes(wanted.state)
        ? wanted.state
        : "open";
    // Restoring text fires the same change event as typing. Suppress the
    // debounce path here; the caller is already about to load this view.
    this.restoringSearch = true;
    this.search.set_value(typeof saved.query === "string" ? saved.query : this.search.value());
    this.listAuthor.set_value(saved.listAuthor || "");
    this.listReviewer.set_value(saved.listReviewer || "");
    this.restoringSearch = false;
    this.serverSearch = searchQuery(this.search.value());
    this.restoreSelection =
      saved.selected && Number.isInteger(saved.selected.number) && saved.selected.number > 0
        ? saved.selected
        : null;
    this.lastUpdated = typeof saved.lastUpdated === "number" ? saved.lastUpdated : null;
  },

  adoptPR(pr, repo = this.repo) {
    const different = requestKey(this.pr) !== requestKey({ ...pr, repository: repo });
    if (!different && this.pr?.headRefOid === pr.headRefOid && pr.provider?.kind === "gitlab") {
      for (const section of ["conversation", "checks"]) if (this.pr.loaded?.[section] && !pr.loaded?.[section]) {
        pr = { ...pr, loaded: { ...pr.loaded, [section]: true } };
        for (const field of section === "conversation" ? ["comments", "threads", "reviews"] : ["checks"])
          pr[field] = this.pr[field];
      }
    }
    if (different) {
      this.leavePR();
      const saved = this.readStored(this.detailKey({ ...pr, repository: repo }));
      this.section = SECTIONS.includes(saved.section) ? saved.section : SECTIONS[0];
      this.author = typeof saved.author === "string" ? saved.author : "";
      this.unresolved = Boolean(saved.unresolved);
      this.workflowOpen =
        saved.workflowOpen && typeof saved.workflowOpen === "object" ? saved.workflowOpen : {};
      this.checkOpen =
        saved.checkOpen && typeof saved.checkOpen === "object" ? saved.checkOpen : {};
      this.composer = null;
      this.draftKey = null;
      // Cleared first so that restoring the draft doesn't write it to the old PR's key.
      this.commentKey = null;
      this.jobs = {};
      this.logs = {};
      this.sectionLoads = {};
      this.prFiles = null;
      this.stateChange = null;
      const commentKey = `pr-draft:v2:${this.spaceKey}:${requestKey(pr)}:comment`;
      this.newComment.set_value(localStorage.getItem(commentKey) ?? "");
      this.commentKey = commentKey;
      this.conversationsVisited = this.section === "conversation";
    }
    this.pr = { ...pr, repository: repo };
    const seen = this.readStored(`pr-read:${this.detailKey()}`);
    this.unreadIds = new Set(
      allComments(this.pr)
        .filter((c) => seen[c.id] !== this.commentFingerprint(c))
        .map((c) => c.id),
    );
    this.lastUpdated = Date.now();
    this.rememberView();
  },

  // IDs alone do not detect edits. Hash the body/state so an edited comment
  // becomes unread again without storing full external comment bodies.
  commentFingerprint(comment) {
    let hash = 2166136261;
    const body = `${comment.state || ""}:${comment.body || ""}`;
    for (let i = 0; i < body.length; i++) hash = Math.imul(hash ^ body.charCodeAt(i), 16777619);
    return `${body.length}:${hash >>> 0}`;
  },

  markRead() {
    if (!this.pr) return;
    localStorage.setItem(
      `pr-read:${this.detailKey()}`,
      JSON.stringify(
        Object.fromEntries(allComments(this.pr).map((c) => [c.id, this.commentFingerprint(c)])),
      ),
    );
    this.unreadIds = new Set();
  },

  leavePR() {
    if (this.conversationsVisited) this.markRead();
    this.rememberDetail();
    this.conversationsVisited = false;
  },

  selectSection(section, cx) {
    if (this.section === "conversation" && section !== "conversation") this.markRead();
    this.section = section;
    this.notice = null;
    if (section === "conversation") this.conversationsVisited = true;
    if (section === "files") this.loadFiles(cx);
    else this.loadSection(section, cx);
    this.rememberDetail();
    cx.notify();
  },

  // Which Overview groups are shut, the same for every PR.
  toggleGroup(key, cx) {
    if (!this.closedGroups.delete(key)) this.closedGroups.add(key);
    localStorage.setItem("closed-groups", JSON.stringify([...this.closedGroups]));
    cx.notify();
  },

  backToList(cx) {
    if (this.mutating) return;
    this.leavePR();
    this.pr = null;
    this.sectionLoads = {};
    this.pendingPR = null;
    this.restoreSelection = null;
    this.detailToken++;
    this.detailLoading = false;
    this.opening = null;
    this.notice = null;
    this.stateChange = null;
    this.composer = null;
    this.draftKey = null;
    this.rememberView();
    if (!this.items.length) this.loadList(cx);
    cx.notify();
  },

  close() {
    this.leavePR();
    this.rememberView();
  },

  updatedLabel() {
    if (!this.lastUpdated) return "Not updated yet";
    const seconds = Math.max(0, Math.floor((Date.now() - this.lastUpdated) / 1000));
    return seconds < 60
      ? "Updated just now"
      : seconds < 3600
        ? `Updated ${Math.floor(seconds / 60)}m ago`
        : `Updated ${new Date(this.lastUpdated).toLocaleTimeString()}`;
  },
};

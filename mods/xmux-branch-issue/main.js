// Branch Issue: a GitHub/GitLab sidebar, for the current branch and for everything you can
// see. The class is built from separate files, so a method used here may live in:
//   state/saved.js        filters, the open issue and tabs across reloads
//   provider/discovery.js   which issues this copy is looking at
//   provider/reads.js       loading lists and issues through the helper
//   actions/changes.js    state, assignee and comments
//   actions/agents.js     who is on an issue, and handing work to them
//   actions/worktrees.js  starting work: an issue's checkouts
//   actions/menus.js      the popup menus
//   views/list.js, detail.js, comments.js, worktrees.js   the drawing
// provider/model.js says what GitHub/GitLab's answers mean; views/ui.js holds every look.
// Git runs on the checkout's machine. GitHub/GitLab requests go through a local helper that
// reads gh/glab CLI; the mod never sees the key.
import { View } from "gpui-kit";
import { activeWorkspace, workspaceKey } from "./shared/context.js";
import { configureQueries } from "./shared/query-cache.js";
import { InputState, TextareaState } from "gpui-base";
import { nextCommand, layout } from "herdr";
import { loadSettings, duration } from "./settings.js";
import { savedMethods } from "./state/saved.js";
import { discoveryMethods } from "./provider/discovery.js";
import { readMethods } from "./provider/reads.js";
import { changeMethods } from "./actions/changes.js";
import { agentMethods } from "./actions/agents.js";
import { worktreeMethods } from "./actions/worktrees.js";
import { menuMethods } from "./actions/menus.js";
import { listMethods } from "./views/list.js";
import { detailMethods } from "./views/detail.js";
import { commentMethods } from "./views/comments.js";
import { worktreeViewMethods } from "./views/worktrees.js";
import { providerProblem, panelShown } from "./provider/model.js";
import { Panel } from "./views/ui.js";

const CONTEXT_POLL_MS = 1000;
const REFRESH_INTERVAL_MS = 60000;
const NOTICE_MS = 5000;
// Preferences a person may change in the installed mod.json under `settings`.
const DEFAULT_SETTINGS = {
  refresh: { every: "60s", search_debounce: "450ms" },
  branch: { max_identifiers: 4 },
  list: { default: { scope: "all", state: "active", team: "" } },
  worktrees: { root: "~/.herdr/worktrees", open_with: "terminal", move_to_started: false },
};

class ProviderIssues extends View {
  init(_props, cx) {
    configureQueries(cx);
    this.view = localStorage.getItem("view") === "all" ? "all" : "branch";
    this.reopenSaved = true;
    this.closedGroups = new Set(this.readStoredList("closed-groups"));
    this.branchIssues = [];
    this.items = [];
    this.cursor = "";
    this.cache = {};
    this.teams = [];
    this.listToken = 0;
    this.detailToken = 0;
    this.branchToken = 0;
    this.searchToken = 0;

    this.menuFocus = cx.focus_handle();
    this.scopeTrigger = cx.focus_handle();
    this.stateTrigger = cx.focus_handle();
    this.teamTrigger = cx.focus_handle();
    this.statePick = cx.focus_handle();
    this.assigneePick = cx.focus_handle();

    this.settings = DEFAULT_SETTINGS;
    this.settingsProblems = [];
    this.scope = DEFAULT_SETTINGS.list.default.scope;
    this.state = DEFAULT_SETTINGS.list.default.state;
    this.team = DEFAULT_SETTINGS.list.default.team;
    this.section = "overview";
    this.applySettings(cx);
    this.search = InputState.new({ placeholder: "Search · #123 or text" });
    this.search.on("change", (_e, cx) => {
      if (!this.restoringSearch) this.searchChanged(cx);
    });
    this.linkInput = InputState.new({ placeholder: "#123" });
    this.linkInput.on("submit", (_e, cx) => this.linkIssue(cx));
    this.editor = TextareaState.new({ placeholder: "Write a comment…", rows: 4 });
    this.editor.on("change", (_e, cx) => {
      if (this.draftKey) localStorage.setItem(this.draftKey, this.editor.value());
      cx.notify();
    });
    // Its own state, so a new comment stays put while a reply or handoff is being written.
    this.newComment = TextareaState.new({ placeholder: "Write a comment…", rows: 4 });
    this.newComment.on("change", (_e, cx) => {
      if (this.commentKey) localStorage.setItem(this.commentKey, this.newComment.value());
      cx.notify();
    });
    this.startPolling(cx);
    this.listenForCommands(cx);

    const space = panelShown(layout(), "xmux-branch-issue") ? activeWorkspace() : null;
    this.changeSpace(space, workspaceKey(space), cx);
  }

  // Read the installed mod.json once; list defaults apply until a saved view exists.
  applySettings(cx) {
    cx.spawn(async (cx) => {
      const { settings, problems } = await loadSettings("xmux-branch-issue", DEFAULT_SETTINGS);
      this.settings = settings;
      this.settingsProblems = problems;
      const d = DEFAULT_SETTINGS.list.default;
      const untouched =
        !this.viewWasSaved &&
        this.scope === d.scope &&
        this.state === d.state &&
        this.team === d.team;
      const wanted = settings.list.default;
      if (
        untouched &&
        (wanted.scope !== d.scope || wanted.state !== d.state || wanted.team !== d.team)
      ) {
        this.scope = wanted.scope;
        this.state = wanted.state;
        this.team = wanted.team;
        // The first load may already have used the shipped defaults.
        if (this.view === "all") this.loadList(cx);
      }
      cx.notify();
    });
  }

  startPolling(cx) {
    cx.timer.every(CONTEXT_POLL_MS, (cx) => {
      // A confirmation says its piece and goes; an error stays until it's dealt with.
      if (this.notice !== this.noticeShown) {
        this.noticeShown = this.notice;
        this.noticeSince = Date.now();
      } else if (this.notice && Date.now() - this.noticeSince > NOTICE_MS) {
        this.notice = null;
        cx.notify();
      }
      if (!panelShown(layout(), "xmux-branch-issue")) return;
      const sp = activeWorkspace();
      const key = workspaceKey(sp);
      if (key !== this.spaceKey) this.changeSpace(sp, key, cx);
      this.rememberView();
      const minute = Math.floor(Date.now() / 60000);
      if (minute !== this.updatedMinute && this.lastUpdated) {
        this.updatedMinute = minute;
        cx.notify();
      }
      const due =
        Date.now() - (this.refreshed ?? 0) >
        duration(this.settings.refresh.every, REFRESH_INTERVAL_MS);
      // Coming back to a hidden panel makes it due at once, if it's been a while.
      if (!this.busy && !this.mutating && due && panelShown(layout(), "xmux-branch-issue"))
        this.refresh(cx);
    });
  }

  listenForCommands(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.refresh(cx, true);
        cx.notify();
      }
    });
  }

  get busy() {
    return this.providerLoading || this.branchLoading || this.searchPending || this.loading || this.detailLoading;
  }

  render() {
    const root = Panel({ id: "issue-root" });
    const problem = providerProblem(this.error, this.provider);
    if (problem) return this.renderProviderProblem(root, problem);
    if (this.issue) return this.renderDetail(root);
    return this.opening ? this.renderOpening(root) : this.renderList(root);
  }
}

Object.assign(
  ProviderIssues.prototype,
  savedMethods,
  discoveryMethods,
  readMethods,
  changeMethods,
  agentMethods,
  worktreeMethods,
  menuMethods,
  listMethods,
  detailMethods,
  commentMethods,
  worktreeViewMethods,
);

export default ProviderIssues;

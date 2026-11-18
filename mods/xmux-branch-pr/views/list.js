// The two lists, and what sits around them: messages, the footer and refresh.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { theme } from "herdr";
import { cardChecks, prStatus, repoUrl, timeAgo, who, providerName, providerIcon, requestNumber, requestName, requestKey } from "../github/model.js";
import {
  TEXT,
  Busy,
  Button,
  CodeBlock,
  HeaderTab,
  Icon,
  IconButton,
  Message,
  PRRow,
  PanelHeader,
  Row,
  TextButton,
  TextField,
} from "./ui.js";

const scrollFrame = (id, content) =>
  v_flex().relative().flex_1().min_h(0).child(content)
    .child(Scrollbar.vertical(id).mode("scrolling").absolute().inset_0());

const scopes = (provider) => [
  { id: "all", label: provider?.kind === "gitlab" ? "All MRs" : "All PRs" },
  { id: "mine", label: "Created by me" },
  { id: "review-requested", label: "Review requested" },
];
const STATES = [
  { id: "open", label: "Open" },
  { id: "draft", label: "Draft" },
  { id: "merged", label: "Merged" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];
const labelOf = (choices, id) => choices.find((c) => c.id === id)?.label ?? "";

export const stateIcon = (status, t, size = 15) =>
  Icon(status.icon, size).text_color(t[status.color]).accessibility_label(status.label);

export const listMethods = {
  // Errors, confirmations and settings problems, under whichever header is showing.
  messages(root) {
    const t = theme();
    if (this.error)
      root.child(
        h_flex()
          .id("pr-error")
          .flex_none()
          .px(8)
          .gap(8)
          .items_center()
          .child(div().flex_1().min_w(0).child(Message(this.error, true)))
          .child(
            TextButton({
              id: "pr-retry",
              icon: "refresh",
              label: "Retry",
              disabled: this.busy || this.mutating,
              onClick: (cx) => this.refresh(cx, true),
            }),
          ),
      );
    if (this.notice)
      root.child(
        div().flex_none().px(14).py(5).text_size(TEXT.small).text_color(t.done).child(this.notice),
      );
    if (this.settingsProblems.length)
      root.child(
        div()
          .id("pr-settings-problems")
          .px(14)
          .py(5)
          .flex_none()
          .text_size(TEXT.caption)
          .text_color(t.ansi1)
          .whitespace_normal()
          .child(`mod.json settings: ${this.settingsProblems.join("; ")}`),
      );
    return root;
  },

  refreshButton() {
    return IconButton({
      id: "pr-refresh",
      icon: "refresh",
      label: `Refresh ${requestName(this.pr?.provider ?? this.provider, true)}`,
      spinning: Boolean(this.busy),
      disabled: this.busy || this.mutating,
      onClick: (cx) => this.refresh(cx, true),
    });
  },

  // Waiting on a count not known yet. A background refresh of a filter already
  // read keeps showing its number.
  repoCountPending() {
    if (!this.listLoaded || this.searchPending) return true;
    return Boolean(this.loading) && !this.cache[this.listKey()];
  },

  showView(view, cx) {
    const sole = view === this.view && this.soleBranchPR();
    if (sole && sole.number === this.pr?.number) return;
    if (this.pr || this.opening) this.backToList(cx);
    if (this.pr) return; // a write is under way, and leaving waits for it
    this.view = view;
    this.notice = null;
    localStorage.setItem("view", view);
    this.openSoleBranchPR(cx);
    cx.notify();
  },

  listHeader() {
    const more = Object.keys(this.cursors).length > 0 ? "+" : "";
    return PanelHeader()
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(4)
          .items_center()
          .role("tab_list")
          .child(
            HeaderTab({
              id: "pr-view-branch",
              label: "Branch",
              count: this.branchPRs.length,
              loading: !this.branchLoaded,
              disabled: !this.branchLoaded,
              active: this.view === "branch",
              onClick: (cx) => this.showView("branch", cx),
            }),
          )
          .child(
            HeaderTab({
              id: "pr-view-all",
              label: "Repo",
              // Use a real total where supplied; otherwise show the loaded count.
              count: this.total ?? `${this.items.length}${more}`,
              loading: this.repoCountPending(),
              disabled: !this.listLoaded,
              active: this.view === "all",
              onClick: (cx) => this.showView("all", cx),
            }),
          ),
      )
      .child(this.refreshButton());
  },

  filters() {
    const SCOPES = scopes(this.provider);
    const choosers = h_flex()
      .gap(6)
      .items_center()
      .child(
        this.chooser({
          id: "pr-scope",
          label: labelOf(SCOPES, this.tab),
          accessibilityLabel: `Whose ${requestName(this.provider, true)}`,
          anchor: "top_left",
          width: 130,
          choices: SCOPES,
          value: this.tab,
          triggerFocus: this.scopeTrigger,
          onChoose: (tab, cx) => {
            this.tab = tab;
            this.restoringSearch = true;
            if (tab === "mine") this.listAuthor.set_value("");
            if (tab === "review-requested") this.listReviewer.set_value("");
            this.restoringSearch = false;
            this.loadList(cx);
          },
        }),
      )
      .child(
        this.chooser({
          id: "pr-state",
          label: labelOf(STATES, this.state),
          accessibilityLabel: `${requestName(this.provider)} state`,
          anchor: "top_left",
          width: 120,
          choices: STATES,
          value: this.state,
          triggerFocus: this.stateTrigger,
          onChoose: (state, cx) => {
            this.state = state;
            this.loadList(cx);
          },
        }),
      )
      .child(div().flex_1());
    if (this.remotes.length > 1)
      choosers.child(
        this.chooser({
          id: "pr-remote",
          label: this.remote || "Remote",
          accessibilityLabel: "Git remote",
          width: 240,
          choices: this.remotes.map((r) => ({
            id: r.name,
            label: r.name,
            detail: r.repo ? `${r.host}/${r.repo}` : "Not a GitHub or GitLab remote",
            disabled: !r.repo,
          })),
          value: this.remote,
          triggerFocus: this.remoteTrigger,
          onChoose: (name, cx) => this.chooseRemote(name, cx),
        }),
      );
    if (this.repo)
      choosers.child(
        IconButton({
          id: "pr-repo-provider",
          icon: providerIcon(this.provider),
          label: `Open ${this.repo} on ${providerName(this.provider)}`,
          onClick: (cx) => cx.open_url(repoUrl(this.repo, this.provider)),
        }),
      );
    if (this.repo) choosers.child(IconButton({ id: "pr-create", icon: "plus", label: `Create on ${providerName(this.provider)}`,
      onClick: cx => cx.open_url(`${repoUrl(this.repo, this.provider)}/${this.provider?.kind === "gitlab" ? "-/merge_requests/new" : "compare"}`) }));
    const t = theme();
    return v_flex()
      .id("pr-filter-row")
      .flex_none()
      .px(14)
      .py(10)
      .gap(8)
      .border_b(1)
      .border_color(t.border)
      .child(h_flex().child(TextField({ id: "pr-search-input", state: this.search })))
      .child(h_flex().gap(6)
        .child(div().flex_1().min_w(0).child(TextField({ id: "pr-list-author", state: this.listAuthor, height: 26 })))
        .child(div().flex_1().min_w(0).child(TextField({ id: "pr-list-reviewer", state: this.listReviewer, height: 26 }))))
      .child(choosers);
  },

  prRow(p, t, where) {
    const checks = cardChecks(p);
    return PRRow({
      id: `pr-${requestKey(p)}`,
      icon: stateIcon(prStatus(p), t),
      title: p.title,
      number: requestNumber(p),
      meta: `${who(p)} · ${timeAgo(p.updatedAt)} · ${p.provider?.host || ""}/${where}`,
      checks:
        checks &&
        Icon(`check-${checks.kind}`, 14)
          .text_color(t[checks.color])
          .accessibility_label(`Checks: ${checks.label}`),
      onClick: (cx) => {
        this.composer = null;
        this.author = "";
        this.jobs = {};
        this.logs = {};
        this.notice = null;
        this.opening = { number: p.number, provider: p.provider };
        this.openPR(p.number, cx, p.repository ?? this.repo, p.provider);
        cx.notify();
      },
    });
  },

  branchList(t) {
    if (!this.branchPRs.length && this.branchLoading) return Busy("Loading this branch’s PRs / MRs…");
    const list = v_flex().id("pr-branch-list").flex_1().min_h(0).overflow_y_scroll().p(6).gap(2);
    if (!this.branchPRs.length)
      list.child(
        Message(
          this.branch
            ? `No PRs / MRs from ${this.branch}.`
            : "Check out a branch to see its PRs / MRs.",
        ),
      );
    return scrollFrame("pr-branch-list", list.children(this.branchPRs.map((p) => this.prRow(p, t, p.repository ?? this.repo))));
  },

  // The selected provider owns matching, including qualifiers where supported.
  moreLabel() {
    const left = (this.total ?? 0) - this.items.length;
    if (left <= 0) return "Load more";
    return `+ ${Math.min(left, this.settings.list.page_size)} more`;
  },

  allList(t) {
    if (!this.items.length && this.busy) return Busy(`Loading ${requestName(this.provider, true)}…`);
    const list = v_flex()
      .id(`pr-list-${this.listKey()}`)
      .flex_1()
      .min_h(0)
      .overflow_y_scroll()
      .p(6)
      .gap(2);
    if (!this.items.length)
      list.child(
        Message(!this.repo ? "Open a folder with a GitHub or GitLab remote." : `No matching ${requestName(this.provider, true)}.`),
      );
    list.children(this.items.map((p) => this.prRow(p, t, p.headRefName)));
    if (Object.keys(this.cursors).length > 0)
      list.child(
        Row({
          id: "pr-more",
          onClick: this.loading || this.searchPending ? null : (cx) => this.loadList(cx, true),
        })
          .justify_center()
          .text_size(TEXT.small)
          .text_color(t.muted)
          .child(this.loading ? "Loading…" : this.moreLabel()),
      );
    return scrollFrame(`pr-list-${this.listKey()}`, list);
  },

  renderList(root) {
    const t = theme();
    root.child(this.listHeader());
    this.messages(root);
    if (this.view === "all") root.child(this.filters()).child(this.allList(t));
    else root.child(this.branchList(t));
    return root.child(this.footer());
  },

  // Nothing works without the selected provider CLI, so this replaces everything below the tabs.
  renderProviderProblem(root, problem) {
    const t = theme();
    root.child(this.listHeader());
    root.child(
      v_flex()
        .id("pr-provider-problem")
        .flex_1()
        .min_h(0)
        .px(24)
        .gap(12)
        .items_center()
        .justify_center()
        .child(Icon(providerIcon(this.provider), 24).text_color(t.dim))
        .child(div().font_medium().child(problem.title))
        .child(
          div()
            .text_size(TEXT.small)
            .text_color(t.muted)
            .whitespace_normal()
            .text_center()
            .child(problem.detail),
        )
        .child(CodeBlock(problem.command))
        .child(
          h_flex()
            .gap(8)
            .when(problem.kind === "missing", (el) =>
              el.child(
                Button({
                  id: "pr-get-provider",
                  label: "Install CLI",
                  onClick: (cx) => cx.open_url(problem.url || "https://cli.github.com"),
                }),
              ),
            )
            .child(
              Button({
                id: "pr-provider-retry",
                label: this.busy ? "Checking…" : "Try again",
                primary: true,
                disabled: this.busy,
                onClick: (cx) => {
                  this.error = null;
                  this.refresh(cx, true);
                },
              }),
            ),
        ),
    );
    return root.child(this.footer());
  },

  // From opening a PR until it arrives, the content is only this.
  renderOpening(root) {
    root.child(this.listHeader());
    this.messages(root);
    if (this.showsBack(this.opening.number))
      root.child(h_flex().flex_none().px(8).py(5).child(this.backButton()));
    root.child(Busy(`Loading ${requestNumber(this.opening)}…`));
    return root.child(this.footer());
  },

  footer() {
    const t = theme();
    const selected = this.pr ?? this.pendingPR;
    const records = selected ? [selected] : this.view === "branch" ? this.branchPRs : [];
    const repositories = [...new Map(records.map(p => [
      JSON.stringify([p.provider?.kind, p.provider?.host, p.repository]), p,
    ])).values()];
    const provider = selected?.provider ?? repositories[0]?.provider ?? this.provider;
    const mixed = new Set(repositories.map(p => p.provider?.kind)).size > 1;
    const name = mixed ? "Pull / Merge Requests" : provider?.kind === "gitlab" ? "Merge Requests" : "Pull Requests";
    const repo = repositories.length > 1 ? "Multiple repositories" : selected?.repository ?? repositories[0]?.repository ?? this.repo;
    const addresses = repositories.length
      ? repositories.map(p => `${p.provider?.host || ""}/${p.repository}`).join("\n")
      : this.repo ? `${provider?.host || ""}/${this.repo}` : "";
    const branch = this.pr?.headRefName || this.branch;
    const count = !selected && this.view === "all" && this.listLoaded
      ? `${this.items.length} loaded${this.total != null ? ` / ${this.total}` : ""}` : "";
    const context = [branch || (this.repoLoading ? "Finding repository…" : "No branch"), count].filter(Boolean).join(" · ");
    return h_flex()
      .id("pr-footer")
      .h(46)
      .flex_none()
      .px(14)
      .gap(8)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .text_size(TEXT.caption)
      .text_color(t.dim)
      .child(div().flex_none().tooltip(name).child(Icon(mixed ? "pull-request" : providerIcon(provider))))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex().gap(6).min_w(0).items_center()
              .child(div().flex_none().font_medium().child(name))
              .child(div().flex_1().min_w(0).truncate().tooltip(addresses).child(repo || "No repository")),
          )
          .child(
            h_flex().gap(8).min_w(0).items_center()
              .child(div().flex_1().min_w(0).truncate().tooltip(context).child(context))
              .child(div().flex_none()
                .tooltip(this.lastUpdated ? new Date(this.lastUpdated).toLocaleString() : "")
                .child(this.busy ? "Updating…" : this.updatedLabel())),
          ),
      );
  },
};

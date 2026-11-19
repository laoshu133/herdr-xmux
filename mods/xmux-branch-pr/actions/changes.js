// What this panel writes to the selected hosting service, always from an explicit click: merging and
// closing, re-requesting a review, and comments, replies and resolving.
import { requestKey, requestNumber, providerName } from "../shared/provider.js";
import { STATE_CHANGES } from "../github/model.js";

export const changeMethods = {
  // Merge, close and reopen go through a confirmation row: they reach everyone
  // on the PR, and a merge cannot be taken back.
  askStateChange(event, cx) {
    this.stateChange = {
      event,
      identity: requestKey(this.pr),
      provider: this.pr.provider,
      repo: this.pr.repository,
      number: this.pr.number,
      head: this.pr.headRefOid,
      method: this.pr.mergeMethods?.[0],
      id: this.pr.id,
    };
    if (event === "squash") {
      const { title, number, body } = this.pr;
      const subject = `${title} (${requestNumber(this.pr)})`;
      this.squashMessage.set_value(body?.trim() ? `${subject}\n\n${body.trim()}` : subject);
      this.squashMessage.focus();
    }
    this.error = null;
    cx.notify();
  },

  changeState(cx) {
    const change = this.stateChange;
    if (!change || this.mutating || change.identity !== requestKey(this.pr)) return;
    const key = this.spaceKey;
    this.mutating = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.api({
          action: "change-state",
          provider: change.provider,
          repo: change.repo,
          number: change.number,
          event: change.event,
          head: change.head,
          ...(change.event === "squash" ? { body: this.squashMessage.value().trim() } : {}),
          ...(change.event === "auto"
            ? { method: change.method ?? "merge", id: change.id }
            : {}),
        });
        if (key !== this.spaceKey || change.identity !== requestKey(this.pr)) return;
        this.stateChange = null;
        this.notice = STATE_CHANGES[change.event].done;
        this.items = []; // the list shows this PR's old state until it reloads
        this.openPR(change.number, cx, change.repo, change.provider);
      } catch (e) {
        if (key === this.spaceKey)
          this.error = `${e.message}. Refresh before retrying if it may have gone through.`;
      } finally {
        this.mutating = false;
        cx.notify();
      }
    });
  },

  requestReviewAgain(reviewer, cx) {
    if (this.mutating || !this.pr) return;
    const key = this.spaceKey;
    const repo = this.pr.repository;
    const number = this.pr.number;
    const provider = this.pr.provider;
    const identity = requestKey(this.pr);
    this.mutating = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.api({ action: "reviewer", provider, repo, number, reviewer });
        if (key !== this.spaceKey || identity !== requestKey(this.pr)) return;
        this.notice = `Asked ${reviewer} to review again.`;
        this.openPR(number, cx, repo, provider);
      } catch (e) {
        if (key === this.spaceKey) this.error = e.message;
      } finally {
        this.mutating = false;
        cx.notify();
      }
    });
  },

  compose(kind, thread, context, cx, options = {}) {
    if (this.mutating) return;
    this.composer = { kind, thread, context, ...options };
    this.target = options.target ?? null;
    this.draftKey = `pr-draft:v2:${this.spaceKey}:${requestKey(this.pr)}:${kind}:${thread ?? "general"}:${options.entry ?? ""}:${options.target ?? ""}`;
    const draft = localStorage.getItem(this.draftKey);
    const initial =
      kind === "agent"
        ? "Analyze this comment and suggest a response or fix."
        : (options.prefix ?? "");
    const text = draft ?? initial;
    this.editor.set_value(text);
    // After a prefilled `@name`, so what's typed follows it.
    this.editor.set_selected_range({ start: text.length, end: text.length });
    this.editor.focus();
    cx.notify();
  },

  closeComposer(cx) {
    if (this.mutating) return;
    this.composer = null;
    this.draftKey = null;
    cx.notify();
  },

  postComment(cx) {
    const draft = this.commentKey;
    this.mutate("comment", cx, undefined, {
      body: this.newComment.value(),
      saved: () => {
        this.newComment.set_value("");
        localStorage.removeItem(draft);
      },
    });
  },

  mutate(action, cx, thread, { body = this.editor.value(), saved } = {}) {
    if (this.mutating) return;
    const key = this.spaceKey;
    const repo = this.pr.repository;
    const number = this.pr.number;
    const provider = this.pr.provider;
    const identity = requestKey(this.pr);
    const draft = this.draftKey;
    this.mutating = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.api({ action, provider, repo, number, thread, body });
        if (key !== this.spaceKey || identity !== requestKey(this.pr))
          return;
        if (saved) saved();
        else if (action === "comment" || action === "reply") {
          localStorage.removeItem(draft);
          this.composer = null;
          this.draftKey = null;
        }
        this.notice = `Saved to ${providerName(provider)}.`;
        this.openPR(number, cx, repo, provider);
      } catch (e) {
        if (key === this.spaceKey)
          this.error = `${e.message}. Refresh before retrying if the request may have succeeded.`;
      } finally {
        this.mutating = false;
        cx.notify();
      }
    });
  },
};

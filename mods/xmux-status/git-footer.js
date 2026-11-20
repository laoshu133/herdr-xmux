import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { window } from "herdr";
import { activeWorkspace } from "./shared/context.js";
import { readGitStatus } from "./shared/git-status.js";
import { cachedQuery, peekQuery } from "./shared/query-cache.js";

const GIT_TTL = 10000;
const gitKey = (workspace) => workspace?.folder
  ? JSON.stringify(["status-git", workspace.machine ?? null, workspace.folder, workspace.branch ?? ""])
  : "";

export class GitFooter {
  pending = new Set();

  refresh(cx) {
    const workspace = activeWorkspace();
    const key = gitKey(workspace);
    const changed = key !== this.key;
    if (changed) {
      this.key = key;
      this.status = key ? peekQuery(key) : undefined;
      cx.notify();
    }
    if (!key || (!changed && window()?.active === false) ||
        this.pending.has(key) || peekQuery(key, GIT_TTL) !== undefined) return;

    this.pending.add(key);
    cx.spawn(async (cx) => {
      try {
        const next = await cachedQuery(key, GIT_TTL, () =>
          readGitStatus(workspace.folder, workspace.machine ?? null));
        if (key === this.key && JSON.stringify(this.status) !== JSON.stringify(next)) {
          this.status = next;
          cx.notify();
        }
      } catch {
        if (key === this.key && this.status !== undefined) {
          this.status = undefined;
          cx.notify();
        }
      } finally {
        this.pending.delete(key);
      }
    });
  }

  render(space, t, cx) {
    const key = gitKey(space);
    if (key !== this.key && !this.refreshScheduled) {
      this.refreshScheduled = true;
      // Space changes cause a render before the periodic refresh runs.
      cx.timer.after(0, (cx) => {
        this.refreshScheduled = false;
        this.refresh(cx);
      });
    }
    const status = key === this.key ? this.status : peekQuery(key);
    const branch = status === undefined ? space?.branch : status?.branch;
    if (!branch) return null;
    const label = branch === "(detached)" && status?.oid
      ? `detached @${status.oid.slice(0, 7)}` : branch;
    const group = h_flex().gap(5).min_w(0).items_center()
      .child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none())
      .child(div().min_w(0).truncate().tooltip(label).child(label));
    if (!status) return group;

    const markers = [
      status.conflicted && ["=", t.ansi1, "Conflicts"],
      status.modified && ["!", t.ansi3, "Tracked changes"],
      status.untracked && ["?", t.dim, "Untracked files"],
      status.ahead && [`⇡${status.ahead}`, t.ansi2, `${status.ahead} ahead of upstream`],
      status.behind && [`⇣${status.behind}`, t.ansi1, `${status.behind} behind upstream`],
    ].filter(Boolean);
    const text = (value, color) => div().text_color(color).child(value);
    if (markers.length) {
      group.child(h_flex().flex_none().tooltip(markers.map(([, , description]) => description).join(" · "))
        .child(text("[", t.dim))
        .children(markers.map(([value, color]) => text(value, color)))
        .child(text("]", t.dim)));
    }
    return group;
  }
}

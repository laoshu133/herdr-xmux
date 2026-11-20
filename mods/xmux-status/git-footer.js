import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, window } from "herdr";
import { activeWorkspace } from "./shared/context.js";
import { readGitStatus } from "./shared/git-status.js";
import { cachedQuery, peekQuery } from "./shared/query-cache.js";

const GIT_TTL = 10000;

export async function readGitFooter(cwd, on) {
  const status = await readGitStatus(cwd, on);
  if (!status?.modified || !status.oid || status.oid === "(initial)") return status;

  // One comparison with HEAD counts the net staged and unstaged edits.
  const diff = await exec("git", [
    "--no-optional-locks", "-c", "core.fsmonitor=false",
    "diff", "--no-relative", "--no-ext-diff", "--no-textconv", "--numstat", "HEAD", "--",
  ], { cwd, on, timeout: 5000 }).catch(() => null);
  if (diff?.code !== 0) return status;
  let add = 0;
  let del = 0;
  for (const line of diff.stdout.split("\n")) {
    const match = /^(\d+)\t(\d+)\t/.exec(line);
    if (!match) continue;
    add += Number(match[1]);
    del += Number(match[2]);
  }
  return { ...status, add, del };
}

export class GitFooter {
  pending = new Set();

  refresh(cx) {
    const workspace = activeWorkspace();
    const cwd = workspace?.folder;
    const on = workspace?.machine ?? null;
    const key = cwd ? JSON.stringify(["status-git", on, cwd, workspace.branch ?? ""]) : "";
    this.space = workspace?.id;
    const changed = key !== this.key;
    if (changed) {
      this.key = key;
      this.status = key ? peekQuery(key, GIT_TTL) : undefined;
      cx.notify();
    }
    if (!key || (!changed && window()?.active === false) ||
        this.pending.has(key) || peekQuery(key, GIT_TTL) !== undefined) return;

    this.pending.add(key);
    cx.spawn(async (cx) => {
      try {
        const next = await cachedQuery(key, GIT_TTL, () => readGitFooter(cwd, on));
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

  render(space, t) {
    const status = space?.id === this.space ? this.status : undefined;
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
    if (status.add || status.del) {
      group.child(h_flex().flex_none().tooltip("Net tracked line changes relative to HEAD")
        .child(text("(", t.dim))
        .child(h_flex().gap(4).child(text(`+${status.add}`, t.ansi2)).child(text(`−${status.del}`, t.ansi1)))
        .child(text(")", t.dim)));
    }
    return group;
  }
}

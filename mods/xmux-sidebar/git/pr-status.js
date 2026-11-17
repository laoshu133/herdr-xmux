// Read-only PR discovery for each [machine, checkout]. This observer is separate
// from space rendering so frequent redraws never launch Git or hosting CLI commands.
import { exec, readTextFile, appHome } from "herdr";
import { resolveProvider, repositoryKey, requestKey, decodeBinding } from "../shared/provider.js";
import { cliExec, hostingApi, apiPages, queryString } from "../shared/hosting.js";
import { normalizeMergeRequest } from "../shared/merge-request.js";
import { cachedQuery, configureQueries } from "../shared/query-cache.js";

export const PR_POLL_MS = 60000;
export const prPlaceKey = (machine, folder) => JSON.stringify([machine ?? null, folder]);
const PR_FIELDS =
  "id,number,title,url,state,isDraft,headRefName,headRepository,updatedAt,statusCheckRollup,reviewDecision,mergeStateStatus";

/** Terminal PR states win over draft/CI flags left over from when it was open. */
export function prAppearance(pr, colors) {
  if (pr.state === "MERGED") return { icon: "merged", color: colors.ansi5, label: "Merged" };
  if (pr.state === "CLOSED") return { icon: "closed", color: colors.ansi1, label: "Closed" };
  if (pr.isDraft) return { icon: "draft", color: colors.dim, label: "Draft" };
  const failed = pr.headPipeline?.status === "failed" || (pr.statusCheckRollup ?? []).some((check) =>
    ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(
      String(check.conclusion || check.state || check.status).toUpperCase(),
    ),
  );
  const open = (color, label, ready = false) => ({ icon: "pull-request", color, label, ready });
  if (["DIRTY", "CONFLICT", "CANNOT_BE_MERGED"].includes(pr.mergeStateStatus)) return open(colors.ansi1, "Conflicts");
  if (failed) return open(colors.ansi1, "Checks failed");
  if (pr.provider?.kind === "gitlab") {
    const statuses = { REQUESTED_CHANGES: "Changes requested", NOT_APPROVED: "Approval required", DISCUSSIONS_NOT_RESOLVED: "Unresolved discussions", NEED_REBASE: "Rebase required", CI_MUST_PASS: "Pipeline must pass", CI_STILL_RUNNING: "Pipeline running" };
    if (statuses[pr.mergeStateStatus]) return open(colors.ansi3, statuses[pr.mergeStateStatus]);
    if (["MERGEABLE", "CAN_BE_MERGED"].includes(pr.mergeStateStatus) && pr.mergeable === "MERGEABLE") return open(colors.ansi2, "Ready to merge", true);
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") return open(colors.ansi3, "Changes requested");
  // CLEAN is GitHub's own "mergeable now": an empty decision means no review is required.
  if (pr.mergeStateStatus === "CLEAN" && (pr.reviewDecision === "APPROVED" || !pr.reviewDecision))
    return open(colors.ansi2, "Ready to merge", true);
  return open(colors.ansi2, "Open");
}

/**
 * One observer per sidebar. Git runs on the checkout's machine; hosting CLIs run locally,
 * using the person's existing authentication. No helper executable is required.
 * Maps include the machine in their keys so remote paths cannot collide.
 */
export class PRStatusObserver {
  constructor() {
    this.places = new Map(); // Current checkout snapshots, replaced on refresh.
    this.checked = new Map(); // Checkout key -> last attempt time and branch.
    this.entries = new Map(); // Checkout key -> last published PRs or error.
    this.cache = new Map(); // Hosting argument list -> short-lived response cache.
  }

  refresh(places, cx) {
    configureQueries(cx);
    this.places = new Map(
      places
        .filter((place) => place.folder)
        .map((place) => [prPlaceKey(place.machine, place.folder), place]),
    );
    for (const key of this.entries.keys()) if (!this.places.has(key)) this.entries.delete(key);
    for (const key of this.checked.keys()) if (!this.places.has(key)) this.checked.delete(key);
    for (const [key, value] of this.cache)
      if (Date.now() - value.at >= PR_POLL_MS) this.cache.delete(key);
    if (this.busy) return;

    const due = [...this.places].filter(([key, place]) => {
      const last = this.checked.get(key);
      return !last || last.branch !== place.branch || Date.now() - last.at >= PR_POLL_MS;
    });
    // checkNew runs frequently. Do not spawn tasks or redraw on cache hits.
    if (!due.length) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        for (const [key, place] of due) {
          if (!this.isCurrent(key, place)) continue;
          this.checked.set(key, { at: Date.now(), branch: place.branch });
          try {
            const prs = await this.lookup(place);
            if (this.isCurrent(key, place)) {
              this.entries.set(key, { prs, branch: place.branch, updated: Date.now() });
            }
          } catch (error) {
            if (this.isCurrent(key, place)) {
              const previous = this.entries.get(key);
              // Retain last-good status on a network error, but never carry a
              // previous branch's PR across a branch switch.
              this.entries.set(key, {
                prs: previous?.branch === place.branch ? previous.prs : [],
                branch: place.branch,
                error: error.message,
                updated: previous?.updated,
              });
            }
          }
          cx.notify();
        }
      } finally {
        this.busy = false;
      }
    });
  }

  // A lookup may finish after navigation or a branch switch. Publish only if
  // the caller's checkout snapshot still describes a tracked space.
  isCurrent(key, place) {
    return this.places.has(key) && this.places.get(key).branch === place.branch;
  }

  async lookup(place) {
    const git = (args) =>
      exec("git", ["--no-optional-locks", ...args], { cwd: place.folder, on: place.machine });
    const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (head.code !== 0) {
      if (head.code === 1 || /not a git repository/i.test(head.stderr ?? "")) return [];
      throw new Error("Cannot read checkout branch");
    }
    const branch = head.stdout.trim();
    // Explicit worktree bindings survive local branch renames and take
    // precedence over guessing a PR from matching head branch names.
    const association = await git(["config", "--get", `branch.${branch}.herdr-pr`]);
    if (association.code !== 0 && association.code !== 1)
      throw new Error("Cannot read PR association");
    const preferences = await cachedQuery("pr-cli-settings", PR_POLL_MS, async () => {
      const raw = await readTextFile(`${appHome()}/mods/xmux-branch-pr/mod.json`);
      return JSON.parse(raw || "{}").settings || {};
    });
    const tools = preferences.tools || {};
    const binding = decodeBinding(association.stdout?.trim());
    const fetchOne = async (provider, repo, number) => {
      if (provider.kind === "github") {
        const pr = await this.query(["pr", "view", String(number), "--repo", `${provider.host}/${repo}`, "--json", PR_FIELDS], provider, tools);
        return { ...pr, provider, repository: repo };
      }
      const row = await cachedQuery(JSON.stringify(["sidebar-mr", provider, repo, number, tools]), PR_POLL_MS,
        () => hostingApi(provider, `projects/${encodeURIComponent(repo)}/merge_requests/${number}`, { tools }));
      return normalizeMergeRequest(row, repo, provider);
    };
    if (binding) return [await fetchOne(binding.provider, binding.repo, binding.number)];

    const remotes = await git(["remote"]);
    if (remotes.code !== 0) throw new Error("Cannot read Git remotes");
    const repositories = new Map();
    this.remoteError = null;
    for (const name of remotes.stdout.trim().split(/\r?\n/).filter(Boolean)) {
      const result = await git(["remote", "get-url", name]);
      if (result.code !== 0) throw new Error("Cannot read Git remote URL");
      try {
        const provider = await resolveProvider(result.stdout, { tools, hosts: preferences.hosts });
        repositories.set(repositoryKey(provider), provider);
      } catch (e) {
        // Ignore unsupported remotes only when another usable remote exists.
        this.remoteError = e;
      }
    }
    if (!repositories.size && this.remoteError) throw this.remoteError;
    const sourceProjects = new Map();
    for (const provider of repositories.values()) if (provider.kind === "gitlab") {
      try {
        const data = await cachedQuery(JSON.stringify(["sidebar-project", provider, tools]), 300000,
          () => hostingApi(provider, `projects/${encodeURIComponent(provider.repo)}`, { tools }));
        sourceProjects.set(`${provider.host}:${data.id}`, data.path_with_namespace);
      } catch { /* Same-project MRs can still be identified from their response. */ }
    }
    const candidates = [];
    const failures = [];
    const knownHeads = new Set([...repositories.keys()].map(k => k.toLowerCase()));
    for (const provider of repositories.values()) {
      const repository = provider.repo;
      let found;
      try {
        if (provider.kind === "github") found = await this.query(["pr", "list", "--repo", `${provider.host}/${repository}`,
          "--head", branch, "--state", "all", "--limit", "100", "--json", PR_FIELDS], provider, tools);
        else {
          const key = JSON.stringify(["sidebar-mrs", provider, branch, tools]);
          const rows = await cachedQuery(key, PR_POLL_MS, () => apiPages(provider,
            `projects/${encodeURIComponent(repository)}/merge_requests?${queryString({ scope: "all", state: "all", source_branch: branch, order_by: "updated_at", sort: "desc" })}`, { tools }));
          found = rows.map(row => {
            const mr = normalizeMergeRequest(row, repository, provider);
            mr.headRepository.nameWithOwner = sourceProjects.get(`${provider.host}:${mr.sourceProjectId}`) || mr.headRepository.nameWithOwner || "";
            return mr;
          });
        }
      } catch (e) { failures.push(e); continue; }
      for (const pr of found) {
        if (pr.headRefName === branch && knownHeads.has(repositoryKey(provider, pr.headRepository?.nameWithOwner).toLowerCase()))
          candidates.push({ ...pr, provider, repository });
      }
    }
    if (!candidates.length && failures.length) throw failures[0];
    const matches = [...new Map(candidates.map(pr => [requestKey(pr), pr])).values()]
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const open = matches.filter(pr => pr.state === "OPEN");
    return open.length ? open : matches.slice(0, 1);
  }

  async query(args, provider = { kind: "github", host: "github.com" }, tools = {}) {
    const key = JSON.stringify([provider, tools, args]);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < PR_POLL_MS) return cached.data;
    const at = Date.now();
    const result = await cliExec(provider.kind, args, { tools });
    const data = JSON.parse(result.stdout);
    this.cache.set(key, { at, data });
    return data;
  }
}

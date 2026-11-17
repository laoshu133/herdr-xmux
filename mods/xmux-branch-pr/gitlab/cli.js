// GitLab adapter for Branch PR. GitLab is intentionally accessed through the
// user's glab login; no token is read or stored by the mod.
import { exec } from "herdr";

const project = (provider, repo) => `${provider?.host || "gitlab.com"}/${repo}`;
const options = (sp) => ({ cwd: sp?.machine ? undefined : sp?.folder, on: null, timeout: 15000 });

function cliError(result) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  if (/command not found|(?:exec:\s*)?glab: not found|is not installed/i.test(text))
    return new Error("GitLab CLI (glab) is not installed. Install it from https://gitlab.com/gitlab-org/cli, run `glab auth login`, then refresh.");
  if (/not logged|not authenticated|authentication required|auth.*required|unauthorized|401/i.test(text))
    return new Error("GitLab CLI is not logged in. Run `glab auth login` in a terminal, then refresh.");
  return new Error(text || "GitLab request failed.");
}

async function run(sp, provider, repo, args) {
  const result = await exec("glab", ["--repo", project(provider, repo), ...args], options(sp));
  if (result.code !== 0) throw cliError(result);
  return result;
}

async function json(sp, provider, repo, args) {
  const result = await run(sp, provider, repo, [...args, "--output", "json"]);
  try {
    return JSON.parse(result.stdout || "null");
  } catch {
    throw new Error("GitLab returned invalid JSON.");
  }
}

const login = (value) => value?.username || value?.user_name || value?.name || "";
const iso = (value) => value || new Date().toISOString();

export function normalizeMergeRequest(row, repo, provider) {
  const state = String(row.state || (row.merged_at ? "merged" : "opened")).toLowerCase();
  const normalized = state === "merged" ? "MERGED" : state === "closed" ? "CLOSED" : "OPEN";
  const number = Number(row.iid ?? row.number ?? 0);
  return {
    ...row,
    id: String(row.id ?? `${repo}!${number}`),
    number,
    repository: repo,
    title: row.title || `!${number}`,
    url: row.web_url || row.url || `https://${provider?.host || "gitlab.com"}/${repo}/-/merge_requests/${number}`,
    body: row.description || row.body || "",
    state: normalized,
    isDraft: Boolean(row.draft || row.work_in_progress),
    updatedAt: iso(row.updated_at || row.updatedAt),
    createdAt: iso(row.created_at || row.createdAt),
    headRefName: row.source_branch || row.headRefName || "",
    baseRefName: row.target_branch || row.baseRefName || "",
    headRefOid: row.sha || row.diff_refs?.head_sha || "",
    author: { login: login(row.author) },
    headRepository: { nameWithOwner: repo },
    mergeable: String(row.merge_status || "").toLowerCase() === "cannot_be_merged" ? "CONFLICTING" : "MERGEABLE",
    mergeStateStatus: String(row.detailed_merge_status || row.merge_status || "").toUpperCase(),
    mergeMethods: ["merge", "squash"],
    autoMergeAllowed: false,
    autoMergeRequest: null,
    reviewDecision: "",
    reviewers: (row.reviewers || []).map((r) => ({ login: login(r), state: "REQUESTED" })),
    checks: [],
    comments: (row.notes || row.comments || []).map((c) => ({
      id: String(c.id), body: c.body || c.note || "", url: c.url || row.web_url,
      createdAt: iso(c.created_at || c.createdAt), author: { login: login(c.author || c.author_user) },
    })),
    reviews: [],
    threads: [],
    changedFiles: Number(row.changes_count || row.changedFiles || 0),
  };
}

export async function gitlabApi(request, sp, provider) {
  const repo = request.repo;
  switch (request.action) {
    case "branch": {
      const rows = await json(sp, provider, repo, ["mr", "list", "--source-branch", request.branch, "--state", "all", "--per-page", "100"]);
      return { items: (Array.isArray(rows) ? rows : []).map((r) => normalizeMergeRequest(r, repo, provider)) };
    }
    case "list": {
      const state = request.state === "merged" ? "merged" : request.state === "closed" ? "closed" : request.state === "all" ? "all" : "opened";
      const args = ["mr", "list", "--state", state, "--per-page", String(Math.min(100, request.pageSize || 25))];
      if (request.search) args.push("--search", request.search);
      const rows = await json(sp, provider, repo, args);
      let items = (Array.isArray(rows) ? rows : []).map((r) => normalizeMergeRequest(r, repo, provider));
      if (request.tab === "mine") {
        const me = await json(sp, provider, repo, ["api", "user"]);
        const who = login(me);
        items = items.filter((r) => r.author?.login === who);
      }
      return { items, cursors: {}, total: items.length };
    }
    case "detail": {
      const row = await json(sp, provider, repo, ["mr", "view", String(request.number)]);
      return normalizeMergeRequest(row, repo, provider);
    }
    case "files":
      return { items: [] };
    case "jobs":
    case "logs":
      return { jobs: [] };
    case "reviewer":
      throw new Error("GitLab reviewer requests are not available through this glab version.");
    case "comment":
    case "reply": {
      await run(sp, provider, repo, ["mr", "note", String(request.number), "--message", request.body || ""]);
      return { ok: true };
    }
    case "resolve":
      return { ok: true };
    case "change-state": {
      const event = request.event;
      if (event === "close") await run(sp, provider, repo, ["mr", "close", String(request.number)]);
      else if (event === "reopen") await run(sp, provider, repo, ["mr", "reopen", String(request.number)]);
      else if (["merge", "squash", "rebase"].includes(event)) {
        const args = ["mr", "merge", String(request.number), "--yes"];
        if (event === "squash") args.push("--squash");
        if (event === "rebase") args.push("--rebase");
        await run(sp, provider, repo, args);
      } else throw new Error("GitLab does not support this merge action.");
      return { ok: true };
    }
    default:
      throw new Error(`Unsupported GitLab PR action: ${request.action}`);
  }
}

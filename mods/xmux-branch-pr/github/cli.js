// Existing GitHub detail/action helper plus explicit host routing and a paged list.
import { requestSearch } from "../shared/provider.js";
import { exec, appHome } from "herdr";
import { cliPath, hostingApi, transient } from "../shared/hosting.js";
import { cachedQuery } from "../shared/query-cache.js";

const CARD = `id number title url state isDraft updatedAt headRefName baseRefName headRefOid author { login }
  headRepository { nameWithOwner } commits(last:1) { nodes { commit { statusCheckRollup { state } } } }`;

export async function githubApi(request, sp, provider) {
  const api = (endpoint, options = {}) => hostingApi(provider, endpoint, { tools: request.tools, ...options });
  if (request.action === "list") {
    const parts = [`repo:${request.repo}`, "is:pr"];
    if (request.state === "draft") parts.push("is:open", "draft:true");
    else if (request.state === "open") parts.push("is:open");
    else if (request.state === "merged") parts.push("is:merged");
    else if (request.state === "closed") parts.push("is:closed", "is:unmerged");
    if (request.tab === "mine" || request.tab === "review-requested") {
      const viewer = await cachedQuery(JSON.stringify(["pr-meta", provider, request.tools, "user"]), 60000, () => api("user"));
      parts.push(`${request.tab === "mine" ? "author" : "review-requested"}:${viewer.login}`);
    }
    if (request.author) parts.push(`author:${request.author}`);
    if (request.reviewer) parts.push(`review-requested:${request.reviewer}`);
    const text = requestSearch(request.search, provider, request.repo);
    const number = /^[#!]?([1-9][0-9]*)$/.exec(text);
    if (number) parts.push(number[1]);
    else if (text) parts.push(text);
    parts.push("sort:updated-desc");
    const size = Math.max(1, Math.min(100, request.pageSize || 25));
    const after = request.cursors?.next ? `,after:${JSON.stringify(request.cursors.next)}` : "";
    // GraphQL queries use POST; only explicit queries opt into read retries.
    const query = `query { search(query:${JSON.stringify(parts.join(" "))},type:ISSUE,first:${size}${after}) {
      issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${CARD} } } } }`;
    const data = await api("graphql", { method: "POST", fields: { query }, readOnly: true });
    if (data.errors?.length) throw new Error(data.errors.map(e => e.message).join("; "));
    if (!data.data?.search) throw new Error("GitHub returned no search result.");
    const result = data.data.search;
    return { items: result.nodes.filter(p => p?.number && (!number || p.number === Number(number[1]))), total: number ? null : result.issueCount,
      cursors: result.pageInfo.hasNextPage ? { next: result.pageInfo.endCursor } : {} };
  }
  if (request.action === "change-state" && ["draft", "ready"].includes(request.event)) {
    const query = `query { repository(owner:${JSON.stringify(request.repo.split("/")[0])}, name:${JSON.stringify(request.repo.split("/")[1])}) {
      pullRequest(number:${request.number}) { id headRefOid viewerCanUpdate } } }`;
    const data = await api("graphql", { method: "POST", fields: { query }, readOnly: true });
    const pr = data.data?.repository?.pullRequest;
    if (!pr?.viewerCanUpdate) throw new Error("You do not have permission to change the draft state.");
    if (pr.headRefOid !== request.head) throw new Error("The source branch changed. Refresh first.");
    const action = request.event === "draft" ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    const result = await api("graphql", { method: "POST", fields: { query: `mutation { ${action}(input:{pullRequestId:${JSON.stringify(pr.id)}}) { pullRequest { id isDraft } } }` } });
    if (result.errors?.length || !result.data?.[action]?.pullRequest) throw new Error(result.errors?.[0]?.message || "GitHub did not confirm the draft state. Refresh before retrying.");
    return { ok: true };
  }
  const tool = await cliPath("github", request.tools);
  // gh's GraphQL/API calls inherit GH_HOST, including Enterprise. The helper
  // receives the absolute CLI path, independent of a GUI process's PATH.
  const read = ["detail", "branch", "files", "jobs", "logs", "viewer"].includes(request.action);
  let data;
  for (let attempt = 0; attempt < (read ? 2 : 1); attempt++) {
    try {
      const result = await exec("/usr/bin/env", [`GH_HOST=${provider.host}`, `${appHome()}/mods/xmux-branch-pr/bin/herdr-pr`,
        JSON.stringify({ ...request, tools: { ...request.tools, github: tool } })],
      { cwd: sp?.machine ? undefined : sp?.folder, on: null, timeout: read ? 15000 : 30000 });
      try { data = JSON.parse(result.stdout); }
      catch { throw new Error(result.stderr || "GitHub helper returned invalid JSON."); }
      if (result.code !== 0 || data?.error) throw new Error(data?.error || result.stderr || "GitHub request failed.");
      break;
    } catch (e) {
      if (!read || attempt > 0 || !transient(String(e.message ?? e))) throw e;
    }
  }
  if (request.action === "detail") {
    try {
      const [owner, name] = request.repo.split("/");
      const query = `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) { viewerPermission pullRequest(number:${request.number}) { viewerCanUpdate viewerCanClose viewerCanReopen baseRefOid labels(first:50) { nodes { name } } } } }`;
      const info = await api("graphql", { method: "POST", fields: { query }, readOnly: true });
      if (info.errors?.length) throw new Error(info.errors[0].message);
      const repo = info.data?.repository, pr = repo?.pullRequest;
      if (!pr) throw new Error("GitHub returned no permission information.");
      data = { ...data, labels: pr.labels?.nodes || [], baseRefOid: pr.baseRefOid, capabilities: {
        update: pr.viewerCanUpdate, close: pr.viewerCanClose, reopen: pr.viewerCanReopen,
        merge: ["ADMIN", "MAINTAIN", "WRITE"].includes(repo.viewerPermission), reviewer: pr.viewerCanUpdate, comment: true,
      } };
    } catch (e) { data = { ...data, permissionError: `Could not read permissions: ${e.message}`,
      capabilities: { update: false, merge: false, reviewer: false, comment: true } }; }
  }
  if (request.action === "files") return { items: data.flat() };
  return data;
}

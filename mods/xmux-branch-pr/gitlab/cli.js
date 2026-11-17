// GitLab REST contracts through glab; no token is read or stored by XMux.
import { requestSearch } from "../shared/provider.js";
import { hostingApi, apiPages, queryString } from "../shared/hosting.js";
import { cachedQuery } from "../shared/query-cache.js";
import { normalizeMergeRequest, applyPermissions, applyApprovals, applyApprovalRules, normalizeDiscussions, normalizeDiff, pipelineStatus } from "./model.js";
export { normalizeMergeRequest } from "./model.js";

export async function gitlabApi(request, _sp, provider) {
  const repo = request.repo;
  const root = `projects/${encodeURIComponent(repo)}`;
  const mr = `${root}/merge_requests/${request.number}`;
  const opts = { tools: request.tools };
  const api = (endpoint, options = {}) => hostingApi(provider, endpoint, { ...opts, ...options });
  const pages = endpoint => apiPages(provider, endpoint, opts);
  const metadata = (endpoint, ttl = 300000) => request.action === "change-state" ? api(endpoint) : cachedQuery(JSON.stringify(["pr-meta", provider, request.tools, endpoint]), ttl, () => api(endpoint));
  const detail = async () => {
    const row = await api(mr);
    const pr = normalizeMergeRequest(row, repo, provider);
    const [project, viewer, approvals, rules] = await Promise.allSettled([metadata(root), metadata("user", 60000), api(`${mr}/approvals`), api(`${mr}/approval_state`)]);
    applyPermissions(pr, row, project.status === "fulfilled" ? project.value : null, viewer.status === "fulfilled" ? viewer.value : null);
    if (pr.capabilities.merge && !pr.mergeMethods.length) pr.mergePolicyUnavailable = "This GitLab instance did not report a supported merge/squash policy. Merge on GitLab.";
    if (project.status === "rejected") pr.policyError = `Could not read project policy: ${project.reason.message}`;
    if (viewer.status === "rejected") pr.permissionError = `Could not read current user: ${viewer.reason.message}`;
    if (approvals.status === "fulfilled") applyApprovals(pr, approvals.value);
    else pr.approvalsError = [404, 405].includes(approvals.reason.status) ? "Approval details are unavailable on this GitLab instance." : approvals.reason.message;
    if (rules.status === "fulfilled") applyApprovalRules(pr, rules.value);
    else if (![404, 405].includes(rules.reason.status)) pr.approvalRulesError = `Could not read approval rules: ${rules.reason.message}`;
    if (row.source_project_id && row.source_project_id !== (row.target_project_id || row.project_id)) {
      try { const source = await metadata(`projects/${row.source_project_id}`); pr.headRepository.nameWithOwner = source.path_with_namespace; }
      catch { pr.sourceProjectUnavailable = true; }
    } else pr.headRepository.nameWithOwner = repo;
    if (pr.mergeStateStatus === "NOT_APPROVED") pr.reviewDecision = "REVIEW_REQUIRED";
    if (pr.mergeStateStatus === "REQUESTED_CHANGES") pr.reviewDecision = "CHANGES_REQUESTED";
    return pr;
  };
  switch (request.action) {
    case "viewer": return api("user");
    case "list":
    case "branch": {
      const branch = request.action === "branch";
      const page = Number(request.cursors?.next || 1);
      const count = branch ? 100 : Math.max(1, Math.min(100, request.pageSize || 25));
      const params = { scope: "all", state: branch || request.state === "all" ? "all" : request.state === "merged" ? "merged" : request.state === "closed" ? "closed" : "opened",
        order_by: "updated_at", sort: "desc", per_page: count, page,
        source_branch: branch ? request.branch : undefined, wip: request.state === "draft" ? "yes" : undefined };
      if (request.author) params.author_username = request.author;
      if (request.reviewer) params.reviewer_username = request.reviewer;
      const query = requestSearch(request.search, provider, repo);
      const number = /^[#!]?([1-9][0-9]*)$/.exec(query);
      if (number) params["iids[]"] = number[1];
      else if (query) params.search = query;
      if (request.tab === "mine" || request.tab === "review-requested") {
        const viewer = await metadata("user", 60000);
        params[request.tab === "mine" ? "author_id" : "reviewer_id"] = viewer.id;
      }
      const rows = branch ? await pages(`${root}/merge_requests?${queryString({ ...params, per_page: undefined, page: undefined })}`)
        : await api(`${root}/merge_requests?${queryString(params)}`);
      if (!Array.isArray(rows)) throw new Error("GitLab returned an invalid merge request list.");
      const items = rows.map(r => normalizeMergeRequest(r, repo, provider));
      let warning;
      if (branch) {
        const ids = [...new Set(items.filter(p => p.sourceProjectId && !p.headRepository.nameWithOwner).map(p => p.sourceProjectId))];
        const sources = await Promise.allSettled(ids.map(id => metadata(`projects/${id}`)));
        if (sources.some(s => s.status === "rejected")) warning = "Some source projects could not be read; branch matches may be incomplete.";
        for (const p of items) {
          const source = sources[ids.indexOf(p.sourceProjectId)];
          if (source?.status === "fulfilled") p.headRepository.nameWithOwner = source.value.path_with_namespace;
        }
      }
      return { items, warning,
        cursors: !branch && rows.length === count ? { next: page + 1 } : {}, total: null };
    }
    case "detail": return detail();
    case "conversation": {
      const pr = request.pr;
      return normalizeDiscussions(await pages(`${mr}/discussions`), pr);
    }
    case "files": {
      const pr = request.pr || { url: `https://${provider.host}/${repo}/-/merge_requests/${request.number}` };
      let rows, warning;
      try { rows = await pages(`${mr}/diffs`); }
      catch (e) {
        if (![404, 405].includes(e.status)) throw e;
        const old = await api(`${mr}/changes`);
        if (!Array.isArray(old.changes)) throw new Error("GitLab returned no file list.");
        rows = old.changes;
        if (old.overflow) warning = "GitLab truncated this diff. Open it on GitLab to view all changes.";
      }
      return { items: rows.map(r => normalizeDiff(r, pr)), warning };
    }
    case "checks": {
      const pipelines = await api(`${mr}/pipelines?per_page=20`);
      if (!Array.isArray(pipelines)) throw new Error("GitLab returned no pipeline list.");
      const head = request.pr?.headPipeline;
      const current = pipelines.filter(p => p.sha === request.pr?.headRefOid || p.id === head?.id);
      if (head && !current.some(p => p.id === head.id)) current.unshift(head);
      return { checks: current.map(p => ({ name: `Pipeline #${p.id}`, workflowName: `Pipeline #${p.id}`,
        runId: p.id, projectId: p.project_id || request.pr?.projectId,
        status: pipelineStatus(p.status), detailsUrl: p.web_url || `https://${provider.host}/${repo}/-/pipelines/${p.id}` })) };
    }
    case "jobs": {
      const path = `projects/${encodeURIComponent(request.projectId || repo)}/pipelines/${request.run}`;
      const jobs = await pages(`${path}/jobs?include_retried=false`);
      let warning;
      try { jobs.push(...await pages(`${path}/bridges`)); }
      catch (e) { warning = `Downstream pipeline jobs could not be read: ${e.message}`; }
      return [{ jobs: jobs.map(j => ({ ...j, conclusion: j.status === "failed" ? "failure" : j.status,
        projectId: request.projectId, nativeGitLab: true, bridge: "downstream_pipeline" in j })), warning }];
    }
    case "logs": {
      const text = await api(`projects/${encodeURIComponent(request.projectId || repo)}/jobs/${request.job}/trace`, { raw: true,
        headers: [`Range: bytes=-${Math.max(1024, request.tail || 60000)}`] });
      const tail = Math.max(1024, request.tail || 60000);
      return { text: text.slice(-tail), truncated: text.length > tail };
    }
    case "comment": {
      if (!String(request.body || "").trim()) throw new Error("Write a comment first.");
      const result = await api(`${mr}/notes`, { method: "POST", fields: { body: request.body } });
      if (!result?.id) throw new Error("GitLab did not confirm the comment. Refresh before retrying.");
      return { ok: true };
    }
    case "reply": {
      if (!request.thread || !String(request.body || "").trim()) throw new Error("A discussion and reply text are required.");
      const result = await api(`${mr}/discussions/${encodeURIComponent(request.thread)}/notes`, { method: "POST", fields: { body: request.body } });
      if (!result?.id) throw new Error("GitLab did not confirm the reply. Refresh before retrying.");
      return { ok: true };
    }
    case "resolve":
    case "reopen": {
      if (!request.thread) throw new Error("A discussion is required.");
      const resolved = request.action === "resolve";
      const result = await api(`${mr}/discussions/${encodeURIComponent(request.thread)}`, { method: "PUT", fields: { resolved } });
      if (!result?.notes?.some(n => n.resolvable) || !result.notes.filter(n => n.resolvable).every(n => n.resolved === resolved))
        throw new Error("GitLab did not confirm the discussion state. Refresh before retrying.");
      return { ok: true };
    }
    case "change-state": {
      const pr = await detail();
      const event = request.event;
      if (request.head && pr.headRefOid !== request.head) throw new Error("The source branch changed. Refresh and review the new commits first.");
      if (["merge", "squash", "auto"].includes(event)) {
        if (!/^[0-9a-f]{40,64}$/i.test(request.head || "")) throw new Error("A verified source commit is required. Refresh first.");
        if (!pr.capabilities.merge || !pr.mergeMethods.length || pr.isDraft) throw new Error("Merging is unavailable: check project policy, permissions and draft state.");
        const method = event === "auto" ? request.method || pr.mergeMethods[0] : event;
        if (!pr.mergeMethods.includes(method)) throw new Error("This merge method is not allowed by the project.");
        if (event === "auto" && !pr.autoMergeAllowed) throw new Error("There is no running pipeline to wait for. Refresh before choosing a merge action.");
        const result = await api(`${mr}/merge`, { method: "PUT", fields: { sha: request.head,
          squash: method === "squash", squash_commit_message: request.body || undefined,
          auto_merge: event === "auto", merge_when_pipeline_succeeds: event === "auto" } });
        if (result?.state !== "merged" && !result?.merge_when_pipeline_succeeds && !result?.auto_merge_enabled)
          throw new Error("GitLab did not confirm the merge. Refresh before retrying.");
      } else if (event === "cancel-auto") {
        if (!pr.capabilities.merge) throw new Error("You do not have permission to cancel auto-merge.");
        const result = await api(`${mr}/cancel_merge_when_pipeline_succeeds`, { method: "POST" });
        if (!result?.id || result.merge_when_pipeline_succeeds || result.auto_merge_enabled)
          throw new Error("GitLab did not confirm cancellation. Refresh before retrying.");
      } else if (event === "rebase-branch") {
        if (!pr.capabilities.rebase) throw new Error("Rebasing this source branch is unavailable.");
        const result = await api(`${mr}/rebase`, { method: "PUT" });
        if (!result?.rebase_in_progress) throw new Error("GitLab did not confirm the rebase. Refresh before retrying.");
      } else if (["close", "reopen", "draft", "ready"].includes(event)) {
        if (!pr.capabilities.update) throw new Error("You do not have permission to update this merge request.");
        const fields = event === "close" || event === "reopen" ? { state_event: event }
          : { title: event === "draft" ? `Draft: ${pr.title.replace(/^(?:Draft:|WIP:)\s*/i, "")}` : pr.title.replace(/^(?:Draft:|WIP:)\s*/i, "") };
        const result = await api(mr, { method: "PUT", fields });
        if (!result?.iid) throw new Error("GitLab did not confirm the change. Refresh before retrying.");
      } else throw new Error("This GitLab action is not supported. Open the merge request on GitLab.");
      return { ok: true };
    }
    case "reviewer": throw new Error("GitLab cannot re-request a review with the same semantics. Manage reviewers on GitLab.");
    default: throw new Error(`Unsupported GitLab action: ${request.action}`);
  }
}

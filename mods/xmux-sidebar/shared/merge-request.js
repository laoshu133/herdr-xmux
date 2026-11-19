// Generated from lib/xmux/merge-request.js. Run node scripts/sync-common.mjs.
// GitLab's project IDs, MR IIDs and native semantics stay explicit in the model.
export const login = (u) => u?.username || u?.login || u?.name || "";
export function pipelineStatus(value) {
  return ({ success: "SUCCESS", failed: "FAILURE", canceled: "CANCELLED", skipped: "SKIPPED",
    running: "IN_PROGRESS", pending: "PENDING", created: "PENDING", preparing: "PENDING",
    waiting_for_resource: "PENDING", scheduled: "PENDING", manual: "MANUAL" })[value] || "UNKNOWN";
}

export function normalizeMergeRequest(row, repo, provider) {
  const number = Number(row.iid);
  const status = String(row.detailed_merge_status || row.merge_status || "unchecked");
  return {
    id: String(row.id), number, repository: repo, provider,
    projectId: row.target_project_id || row.project_id,
    sourceProjectId: row.source_project_id,
    title: row.title || `!${number}`, url: row.web_url || `https://${provider.host}/${repo}/-/merge_requests/${number}`,
    body: row.description || "", state: row.state === "merged" ? "MERGED" : row.state === "closed" ? "CLOSED" : "OPEN",
    isDraft: Boolean(row.draft || row.work_in_progress), author: { login: login(row.author), id: row.author?.id },
    labels: row.labels || [], updatedAt: row.updated_at || "", createdAt: row.created_at || "",
    headRefName: row.source_branch || "", baseRefName: row.target_branch || "",
    headRefOid: row.sha || row.diff_refs?.head_sha || "",
    diffBaseSha: row.diff_refs?.base_sha || "", diffStartSha: row.diff_refs?.start_sha || "",
    headRepository: { nameWithOwner: row.source_project_id === (row.target_project_id || row.project_id) ? repo : "", id: row.source_project_id },
    mergeable: ["conflict", "cannot_be_merged"].includes(status) ? "CONFLICTING" : status === "mergeable" || status === "can_be_merged" ? "MERGEABLE" : "UNKNOWN",
    mergeStateStatus: status.toUpperCase(), mergeMethods: [],
    autoMergeAllowed: false, autoMergeRequest: row.merge_when_pipeline_succeeds || row.auto_merge_enabled ? {} : null,
    reviewDecision: "", reviewers: (row.reviewers || []).map(u => ({ id: u.id, login: login(u), state: "REQUESTED" })),
    reviews: [], comments: [], threads: [], checks: [],
    changedFiles: /^\d+$/.test(String(row.changes_count)) ? Number(row.changes_count) : null,
    changedFilesLabel: row.changes_count || null,
    headPipeline: row.head_pipeline || row.pipeline || null,
    loaded: { conversation: false, checks: false },
    capabilities: { comment: false, update: false, merge: false, reviewer: false },
  };
}

export function applyPermissions(pr, row, project, viewer) {
  const access = Math.max(project?.permissions?.project_access?.access_level || 0, project?.permissions?.group_access?.access_level || 0);
  const author = Boolean(viewer?.id) && row.author?.id === viewer.id;
  pr.viewerId = viewer?.id;
  const update = author || access >= 30;
  const merge = row.user?.can_merge === true;
  const squash = project?.squash_option || "unknown";
  const policyKnown = project && ["merge", "rebase_merge", "ff"].includes(project.merge_method);
  pr.capabilities = { comment: Boolean(viewer), update, merge, reviewer: false,
    rebase: update && (author || row.source_project_id === (row.target_project_id || row.project_id)),
    squash, mergeMethod: project?.merge_method, policyKnown: Boolean(policyKnown) };
  pr.mergeMethods = !merge || !policyKnown || !["never", "always", "default_on", "default_off"].includes(squash) ? []
    : squash === "always" ? ["squash"] : squash === "never" ? ["merge"] : squash === "default_on" ? ["squash", "merge"] : ["merge", "squash"];
  pr.autoMergeAllowed = merge && pr.mergeMethods.length > 0 && Boolean(pr.headPipeline)
    && ["running", "pending", "created", "preparing", "waiting_for_resource"].includes(pr.headPipeline.status);
  return pr;
}

export function applyApprovals(pr, data) {
  const approved = new Set((data.approved_by || []).map(a => a.user?.id));
  const people = new Map(pr.reviewers.map(r => [r.id, r]));
  for (const { user } of data.approved_by || []) if (user) people.set(user.id, { id: user.id, login: login(user), state: "APPROVED" });
  pr.reviewers = [...people.values()].map(r => ({ ...r, state: approved.has(r.id) ? "APPROVED" : r.state }));
  pr.approvals = { required: data.approvals_required, left: data.approvals_left, approved: approved.size };
  pr.reviewDecision = Number(data.approvals_left) > 0 ? "REVIEW_REQUIRED"
    : data.approved === true || approved.size > 0 && data.approvals_left === 0 ? "APPROVED" : "";
  return pr;
}

export function normalizeDiscussions(rows, pr) {
  const comments = [], threads = [];
  for (const row of rows) {
    const notes = (row.notes || []).filter(n => !n.system).map(n => ({
      id: String(n.id), body: n.body || "", author: { login: login(n.author) }, createdAt: n.created_at,
      url: `${pr.url}#note_${n.id}`, position: n.position, resolvable: n.resolvable,
    }));
    if (!notes.length) continue;
    if (row.individual_note) comments.push(...notes);
    else {
      const first = notes[0];
      const resolvable = (row.notes || []).some(n => n.resolvable);
      const resolved = (row.notes || []).filter(n => n.resolvable).every(n => n.resolved);
      threads.push({ id: row.id, path: first.position?.new_path || first.position?.old_path || "",
        line: first.position?.new_line || first.position?.old_line, comments: notes,
        resolvable, isResolved: resolvable && resolved, isOutdated: false,
        viewerCanReply: pr.capabilities.comment,
        viewerCanResolve: resolvable && (pr.capabilities.update || Boolean(pr.viewerId) && row.notes[0]?.author?.id === pr.viewerId),
        viewerCanUnresolve: resolvable && (pr.capabilities.update || Boolean(pr.viewerId) && row.notes[0]?.author?.id === pr.viewerId) });
    }
  }
  return { comments, threads, reviews: [] };
}

export function normalizeDiff(row, pr) {
  const diff = row.diff;
  const lines = String(diff || "").split("\n");
  const unavailable = row.too_large || row.collapsed || typeof diff !== "string" || !diff;
  return { filename: row.new_path || row.old_path, previous_filename: row.renamed_file ? row.old_path : undefined,
    status: row.deleted_file ? "removed" : row.new_file ? "added" : row.renamed_file ? "renamed" : "modified",
    additions: unavailable ? null : lines.filter(l => l.startsWith("+") && !l.startsWith("+++")).length,
    deletions: unavailable ? null : lines.filter(l => l.startsWith("-") && !l.startsWith("---")).length,
    patch: unavailable ? null : diff,
    warning: unavailable ? "Text diff unavailable: binary, empty, collapsed or too large. View on GitLab for details." : null,
    web_url: `${pr.url}/diffs`,
  };
}

export function applyApprovalRules(pr, data) {
  if (!Array.isArray(data?.rules)) return pr;
  const rules = data.rules.filter(r => Number(r.approvals_required) > 0);
  pr.approvalRules = rules.map(r => ({ name: r.name || "Approval rule", required: r.approvals_required, approved: r.approved === true }));
  pr.reviewDecision = rules.length ? rules.every(r => r.approved) ? "APPROVED" : "REVIEW_REQUIRED" : "";
  return pr;
}

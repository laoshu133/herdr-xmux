import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function moduleAt(path, names, deps = {}) {
  const source = (await readFile(new URL(path, import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export \{[^}]*\} from [^;]*;\n/gm, "").replace(/^export /gm, "");
  return new Function("deps", `const {${Object.keys(deps).join(",")}} = deps;\n${source}\nreturn {${names.join(",")}};`)(deps);
}
const provider = { kind: "gitlab", host: "code.example" };
const repo = "group/sub/project";
const sha = "a".repeat(40);
const row = { id: 400, iid: 12, state: "opened", title: "Change", author: { id: 3, username: "me" }, source_project_id: 8,
  target_project_id: 8, source_branch: "feature", target_branch: "main", sha, user: { can_merge: true },
  detailed_merge_status: "mergeable", updated_at: "2026-11-18T12:00:00Z", changes_count: "1", web_url: `https://code.example/${repo}/-/merge_requests/12` };
const project = { id: 8, path_with_namespace: repo, merge_method: "merge", squash_option: "default_off", permissions: { project_access: { access_level: 40 } } };
const providerFns = await moduleAt("../lib/xmux/provider.js", ["requestNumber", "requestKey", "repositoryKey", "requestRef", "encodeBinding", "decodeBinding", "requestName", "requestShort", "requestSearch", "remoteInfo", "configuredProvider"]);
const model = await moduleAt("../lib/xmux/merge-request.js", ["normalizeMergeRequest", "applyPermissions", "applyApprovals", "applyApprovalRules", "normalizeDiscussions", "normalizeDiff", "pipelineStatus", "login"]);
const commonModel = await moduleAt("../mods/xmux-branch-pr/github/model.js", ["stateEvents", "prStats", "mergeBlockers", "conversationEntries", "unresolvedThreads", "fixCheckMessage", "searchQuery"], providerFns);
const cachedQuery = (_key, _ttl, load) => load();

function context() {
  const tasks = [];
  return { tasks, notify() {}, spawn(fn) { tasks.push(fn(this)); }, write_to_clipboard() {} };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function gitlabFixture(override) {
  const calls = [];
  const respond = async (endpoint, options) => {
    if (override) { const value = await override(endpoint, options); if (value !== undefined) return value; }
    if (endpoint === "user") return { id: 3, username: "me" };
    if (endpoint === `projects/${encodeURIComponent(repo)}`) return project;
    if (endpoint.endsWith("/approvals")) return { approved: true, approvals_left: 0, approvals_required: 1, approved_by: [{ user: { id: 3, username: "me" } }] };
    if (/\/merge_requests\/12$/.test(endpoint)) return { ...row };
    if (/merge_requests\?/.test(endpoint)) return [{ ...row }];
    return [];
  };
  const hostingApi = async (p, endpoint, options = {}) => {
    calls.push({ provider: p, endpoint, ...options });
    return respond(endpoint, options);
  };
  const apiPages = (p, endpoint, options) => hostingApi(p, endpoint, options);
  const queryString = v => Object.entries(v).filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  const { gitlabApi } = await moduleAt("../mods/xmux-branch-pr/gitlab/cli.js", ["gitlabApi"], { ...model, ...providerFns, hostingApi, apiPages, queryString, cachedQuery });
  return { calls, api: request => gitlabApi({ repo, number: 12, tools: { gitlab: "/custom/glab" }, ...request }, { machine: "remote" }, provider) };
}

test("host/provider/namespace identities, refs and worktree associations never collide", () => {
  const pr = { provider, repository: repo, number: 12 };
  assert.equal(providerFns.requestNumber(pr), "!12");
  assert.equal(providerFns.requestRef(pr), "refs/merge-requests/12/head");
  assert.notEqual(providerFns.requestKey(pr), providerFns.requestKey({ ...pr, provider: { ...provider, host: "other.example" } }));
  const binding = providerFns.decodeBinding(providerFns.encodeBinding(pr));
  assert.deepEqual([binding.repo, binding.number, binding.provider], [repo, 12, provider]);
  assert.deepEqual(providerFns.decodeBinding("owner/repo#9"), { v: 1, repo: "owner/repo", number: 9, provider: { kind: "github", host: "github.com" } });
  assert.equal(providerFns.decodeBinding('{"v":2,"provider":{"kind":"gitlab","host":"evil/path"},"repo":"a/b","number":1}'), null);
});

test("request URLs are accepted only in their own host, project and platform", () => {
  assert.equal(providerFns.requestSearch(row.web_url, provider, repo), "12");
  assert.equal(providerFns.requestSearch("!12", provider, repo), "!12");
  assert.throws(() => providerFns.requestSearch(row.web_url, { ...provider, host: "other.example" }, repo), /another host/);
  assert.throws(() => providerFns.requestSearch("https://example.com/a/b/pull/12", provider, repo), /another host/);
  assert.equal(commonModel.searchQuery("!1"), "!1");
});

test("SSH aliases explicitly map to the API host without losing GitLab subgroups", () => {
  const parsed = providerFns.remoteInfo("git@git-company:group/sub/project.git");
  assert.equal(parsed.repo, repo);
  assert.deepEqual(providerFns.configuredProvider(parsed, [{ remote: "git-company", kind: "gitlab", host: "code.example" }]), { ...provider, repo });
  assert.throws(() => providerFns.configuredProvider(parsed, [{ remote: "git-company", kind: "unknown", host: "code.example" }]), /Invalid hosting/);
});

test("unknown mergeability and missing approvals are never displayed as Ready or approved", () => {
  const pr = model.normalizeMergeRequest({ ...row, detailed_merge_status: "checking" }, repo, provider);
  assert.equal(pr.mergeable, "UNKNOWN");
  assert.equal(pr.headRepository.nameWithOwner, repo);
  assert.deepEqual(pr.mergeMethods, []);
  const stats = commonModel.prStats(pr);
  assert.equal(stats.find(s => s.key === "merge").value, "Unknown");
  assert.equal(stats.find(s => s.key === "unresolved").value, "–");
  assert.notEqual(stats.find(s => s.key === "reviews").detail, "No review needed");
});

test("GitLab merges honor project squash policy, permissions and native rebase semantics", () => {
  const pr = model.applyPermissions(model.normalizeMergeRequest(row, repo, provider), row, { ...project, squash_option: "always" }, { id: 3 });
  assert.deepEqual(pr.mergeMethods, ["squash"]);
  assert.ok(commonModel.stateEvents(pr).includes("rebase-branch"));
  assert.ok(!commonModel.stateEvents(pr).includes("rebase"));
  const unknown = model.applyPermissions(model.normalizeMergeRequest(row, repo, provider), row, null, null);
  assert.deepEqual(unknown.mergeMethods, []);
  const denied = model.applyPermissions(model.normalizeMergeRequest(row, repo, provider), { ...row, user: { can_merge: false } }, project, { id: 3 });
  assert.ok(!commonModel.stateEvents(denied).includes("merge"));
});

test("MR review counts preserve approval requirements and approved people", () => {
  const pr = model.normalizeMergeRequest({ ...row, reviewers: [{ id: 5, username: "reviewer" }] }, repo, provider);
  model.applyApprovals(pr, { approvals_required: 2, approvals_left: 1, approved_by: [{ user: { id: 5, username: "reviewer" } }] });
  assert.equal(pr.reviewDecision, "REVIEW_REQUIRED");
  assert.equal(pr.reviewers[0].state, "APPROVED");
  assert.equal(pr.approvals.left, 1);
});

test("GitLab draft/filter/pagination are server-side and do not invent total counts", async () => {
  const f = await gitlabFixture(() => undefined);
  const list = await f.api({ action: "list", tab: "mine", state: "draft", pageSize: 1, cursors: { next: 2 }, search: "!12", reviewer: "another" });
  const query = f.calls.find(c => c.endpoint.includes("merge_requests?")).endpoint;
  const params = new URLSearchParams(query.split("?")[1]);
  assert.equal(params.get("state"), "opened");
  assert.equal(params.get("wip"), "yes");
  assert.equal(params.get("author_id"), "3");
  assert.equal(params.get("reviewer_username"), "another");
  assert.equal(params.get("iids[]"), "12");
  assert.equal(params.get("page"), "2");
  assert.equal(list.total, null);
  assert.equal(list.cursors.next, 3);
  assert.deepEqual(f.calls[0].tools, { gitlab: "/custom/glab" });
});

test("GitLab review-requested does not silently become all requests", async () => {
  const f = await gitlabFixture();
  await f.api({ action: "list", tab: "review-requested", state: "closed" });
  const call = f.calls.find(c => c.endpoint.includes("merge_requests?"));
  assert.match(call.endpoint, /reviewer_id=3/);
  assert.match(call.endpoint, /state=closed/);
});

test("branch reads resolve fork source projects rather than attaching another fork's branch", async () => {
  const f = await gitlabFixture(endpoint => endpoint.includes("merge_requests?") ? [{ ...row, source_project_id: 20, references: { full: `${repo}!12` } }]
    : endpoint === "projects/20" ? { path_with_namespace: "fork/sub/project" } : undefined);
  const result = await f.api({ action: "branch", branch: "feature" });
  assert.equal(result.items[0].headRepository.nameWithOwner, "fork/sub/project");
});

test("discussion replies and resolve/reopen make real writes to the selected thread", async () => {
  const f = await gitlabFixture((endpoint, options) => {
    if (endpoint.endsWith("/notes")) return { id: 5 };
    if (endpoint.endsWith("/discussions/abc")) return { id: "abc", notes: [{ resolvable: true, resolved: options.fields.resolved }] };
  });
  await f.api({ action: "reply", thread: "abc", body: "@name $(literal)" });
  await f.api({ action: "resolve", thread: "abc" });
  await f.api({ action: "reopen", thread: "abc" });
  assert.ok(f.calls[0].endpoint.endsWith("/discussions/abc/notes"));
  assert.equal(f.calls[0].method, "POST");
  assert.equal(f.calls[0].fields.body, "@name $(literal)");
  assert.equal(f.calls[1].fields.resolved, true);
  assert.equal(f.calls[2].fields.resolved, false);
  const bad = await gitlabFixture(() => ({}));
  await assert.rejects(bad.api({ action: "resolve", thread: "abc" }), /did not confirm/);
});

test("discussion normalization preserves note links and separates general discussions from unresolved reviews", () => {
  const pr = model.normalizeMergeRequest(row, repo, provider); pr.capabilities = { comment: true, update: true };
  const data = model.normalizeDiscussions([
    { id: "one", individual_note: true, notes: [{ id: 1, body: "general", author: { username: "me" } }] },
    { id: "thread", individual_note: false, notes: [{ id: 2, resolvable: true, resolved: false, position: { new_path: "file.js", new_line: 3 }, author: { username: "them" } }] },
    { id: "general-thread", individual_note: false, notes: [{ id: 3, resolvable: false }] },
  ], pr);
  assert.equal(data.comments.length, 1);
  assert.equal(data.threads[0].id, "thread");
  assert.equal(data.threads[0].line, 3);
  assert.match(data.threads[0].comments[0].url, /#note_2$/);
  assert.equal(commonModel.unresolvedThreads(data).length, 1);
  assert.ok(commonModel.conversationEntries(data).some(e => e.kind === "Discussion"));
});

test("file diffs expose renames, unavailable text and old GitLab overflow", async () => {
  const file = model.normalizeDiff({ old_path: "old.js", new_path: "new.js", renamed_file: true, diff: "@@ -1 +1 @@\n-old\n+new" }, { url: row.web_url });
  assert.equal(file.previous_filename, "old.js");
  assert.equal(file.additions, 1);
  assert.equal(file.deletions, 1);
  assert.equal(model.normalizeDiff({ new_path: "binary", diff: "", too_large: true }, { url: row.web_url }).patch, null);
  const f = await gitlabFixture(endpoint => {
    if (endpoint.endsWith("/diffs")) throw Object.assign(new Error("not found"), { status: 404 });
    if (endpoint.endsWith("/changes")) return { overflow: true, changes: [{ new_path: "one", diff: "+line" }] };
  });
  const result = await f.api({ action: "files" });
  assert.equal(result.items.length, 1);
  assert.match(result.warning, /truncated/);
});

test("pipeline reads show current MR versions, jobs and bounded trace output", async () => {
  const f = await gitlabFixture(endpoint => {
    if (endpoint.endsWith("/pipelines?per_page=20")) return [{ id: 11, project_id: 8, sha, status: "failed" }, { id: 10, sha: "old", status: "success" }];
    if (endpoint.includes("/jobs?")) return [{ id: 30, status: "failed", name: "test" }];
    if (endpoint.endsWith("/trace")) return "z".repeat(2000);
  });
  const data = await f.api({ action: "checks", pr: { headRefOid: sha, projectId: 8 } });
  assert.equal(data.checks.length, 1);
  assert.equal(data.checks[0].status, "FAILURE");
  const jobs = await f.api({ action: "jobs", run: 11, projectId: 8 });
  assert.equal(jobs[0].jobs[0].nativeGitLab, true);
  const log = await f.api({ action: "logs", job: 30, projectId: 8, tail: 1024 });
  assert.equal(log.text.length, 1024);
  assert.equal(log.truncated, true);
});

test("merges reject moved heads and unsupported strategies before any write", async () => {
  const f = await gitlabFixture();
  await assert.rejects(f.api({ action: "change-state", event: "merge", head: "b".repeat(40) }), /source branch changed/);
  assert.ok(f.calls.every(c => !c.method));
  const policy = await gitlabFixture(endpoint => endpoint === `projects/${encodeURIComponent(repo)}` ? { ...project, squash_option: "always" } : undefined);
  await assert.rejects(policy.api({ action: "change-state", event: "merge", head: sha }), /not allowed/);
  assert.ok(policy.calls.every(c => !c.method));
});

test("explicit merge forwards expected SHA and never implicitly enables auto-merge", async () => {
  const f = await gitlabFixture(endpoint => endpoint.endsWith("/merge") ? { id: row.id, state: "merged" } : undefined);
  await f.api({ action: "change-state", event: "squash", head: sha, body: "Commit message" });
  const call = f.calls.find(c => c.method === "PUT");
  assert.equal(call.fields.sha, sha);
  assert.equal(call.fields.squash, true);
  assert.equal(call.fields.merge_when_pipeline_succeeds, false);
  assert.equal(call.fields.squash_commit_message, "Commit message");
});

test("auto-merge is available only for a running pipeline and confirms scheduling", async () => {
  const f = await gitlabFixture(endpoint => {
    if (/\/merge_requests\/12$/.test(endpoint)) return { ...row, head_pipeline: { id: 11, status: "running" } };
    if (endpoint.endsWith("/merge")) return { id: row.id, state: "opened", merge_when_pipeline_succeeds: true };
  });
  await f.api({ action: "change-state", event: "auto", head: sha, method: "merge" });
  assert.equal(f.calls.find(c => c.method === "PUT").fields.merge_when_pipeline_succeeds, true);
  const noPipeline = await gitlabFixture();
  await assert.rejects(noPipeline.api({ action: "change-state", event: "auto", head: sha }), /no running pipeline/);
});

test("CLI transport specifies host and local execution, retries reads once and never replays writes", async () => {
  const calls = [];
  let nextCode = 503;
  const f = await moduleAt("../lib/xmux/hosting.js", ["hostingApi"], { home: () => "/home/me", exec: async (command, args, options) => {
    calls.push({ command, args, options });
    const code = nextCode; nextCode = 0;
    return code ? { code: 1, stderr: "HTTP 503", stdout: "" } : { code: 0, stdout: '{"id":1}' };
  } });
  await f.hostingApi(provider, "user", { tools: { gitlab: "/custom/glab" } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 6), ["api", "--hostname", "code.example", "--method", "GET", "user"]);
  assert.equal(calls[0].options.on, null);
  nextCode = 503;
  await assert.rejects(f.hostingApi(provider, "notes", { method: "POST", fields: { body: "literal" }, tools: { gitlab: "/custom/glab" } }), /503/);
  assert.equal(calls.length, 3);
});

test("GUI PATH fallback is used only for launch failures and respects explicit CLI paths", async () => {
  const calls = [];
  const f = await moduleAt("../lib/xmux/hosting.js", ["cliExec"], { home: () => "/home/me", exec: async (command, _args, options) => {
    calls.push({ command, options });
    if (command === "glab") throw new Error("No such file or directory");
    return { code: 0, stdout: "{}" };
  } });
  await f.cliExec("gitlab", ["api", "user"]);
  assert.deepEqual(calls.map(c => c.command), ["glab", "/home/me/.local/bin/glab"]);
  await f.cliExec("gitlab", ["api", "user"], { tools: { gitlab: "/custom/glab" } });
  assert.equal(calls.at(-1).command, "/custom/glab");
});

test("API pagination reads every page and rejects non-list responses", async () => {
  const calls = [];
  const f = await moduleAt("../lib/xmux/hosting.js", ["apiPages"], { home: () => "/home/me", exec: async (_command, args) => {
    const endpoint = args[5]; calls.push(endpoint);
    return { code: 0, stdout: JSON.stringify(endpoint.endsWith("page=1") ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }]) };
  } });
  const result = await f.apiPages(provider, "projects/8/merge_requests/12/discussions", { tools: { gitlab: "/custom/glab" } });
  assert.equal(result.length, 101);
  assert.equal(calls.length, 2);
});

test("GitHub helper receives an explicit Enterprise host and resolved CLI path", async () => {
  const calls = [];
  const { githubApi } = await moduleAt("../mods/xmux-branch-pr/github/cli.js", ["githubApi"], {
    ...providerFns, cachedQuery, cliPath: async () => "/custom/gh", appHome: () => "/app", hostingApi: async () => ({}),
    exec: async (command, args, options) => { calls.push({ command, args, options }); return { code: 0, stdout: '{"items":[]}' }; },
  });
  const p = { kind: "github", host: "enterprise.example" };
  await githubApi({ action: "branch", repo: "a/b", branch: "main" }, { machine: "remote", folder: "/remote" }, p);
  assert.equal(calls[0].command, "/usr/bin/env");
  assert.equal(calls[0].args[0], "GH_HOST=enterprise.example");
  assert.equal(JSON.parse(calls[0].args[2]).tools.github, "/custom/gh");
  assert.equal(calls[0].options.on, null);
  assert.equal(calls[0].options.cwd, undefined);
});

test("GitHub lists keep cursor pagination and map review-requested to GitHub search", async () => {
  const calls = [];
  const { githubApi } = await moduleAt("../mods/xmux-branch-pr/github/cli.js", ["githubApi"], {
    ...providerFns, cachedQuery, hostingApi: async (_provider, endpoint, options) => {
      calls.push({ endpoint, options });
      return endpoint === "user" ? { login: "me" } : { data: { search: { nodes: [{ number: 12 }], issueCount: 20, pageInfo: { hasNextPage: true, endCursor: "next" } } } };
    },
  });
  const result = await githubApi({ action: "list", repo: "a/b", state: "closed", tab: "review-requested", cursors: { next: "old" } }, {}, { kind: "github", host: "github.com" });
  const q = calls.at(-1).options.fields.query;
  assert.match(q, /review-requested:me/);
  assert.match(q, /is:unmerged/);
  assert.match(q, /after:"old"/);
  assert.equal(result.cursors.next, "next");
  assert.equal(result.total, 20);
});

test("late GitLab section reads cannot overwrite a different host's request", async () => {
  const { readMethods } = await moduleAt("../mods/xmux-branch-pr/github/reads.js", ["readMethods"], providerFns);
  const gate = deferred(), cx = context();
  const state = { ...readMethods, spaceKey: "space", sectionLoads: {}, pr: { provider, repository: repo, number: 12, headRefOid: sha },
    api: () => gate.promise, adoptPR() { throw new Error("must not adopt stale data"); } };
  state.loadSection("conversation", cx);
  state.pr = { ...state.pr, provider: { ...provider, host: "other.example" } };
  gate.resolve({ comments: [{ id: 1 }] });
  await Promise.all(cx.tasks);
  assert.equal(state.pr.comments, undefined);
});

test("Agent CI context uses MR identity, GitLab host and glab log commands", () => {
  const pr = model.normalizeMergeRequest(row, repo, provider);
  const prompt = commonModel.fixCheckMessage(pr, repo, { name: "pipeline", runId: 11, projectId: 8 });
  assert.match(prompt, /MR !12/);
  assert.match(prompt, /glab api --hostname code.example/);
  assert.ok(!prompt.includes("gh run view"));
});

test("approval rules are counted as rules, without confusing reviewer count with approval requirements", async () => {
  const { applyApprovalRules } = await moduleAt("../lib/xmux/merge-request.js", ["applyApprovalRules"]);
  const pr = model.normalizeMergeRequest(row, repo, provider);
  applyApprovalRules(pr, { rules: [{ name: "Owners", approvals_required: 2, approved: false }, { name: "Security", approvals_required: 1, approved: true }] });
  assert.equal(pr.reviewDecision, "REVIEW_REQUIRED");
  assert.equal(commonModel.prStats(pr).find(s => s.key === "reviews").value, "1/2");
});

test("GitLab worktrees use target-host matching, MR refs and a verified immutable commit", async () => {
  const commands = [], cx = context();
  const { worktreeMethods } = await moduleAt("../mods/xmux-branch-pr/actions/worktrees.js", ["worktreeMethods"], {
    ...providerFns, home: () => "/home/me", resolveProvider: async remote => ({ kind: "gitlab", ...providerFns.remoteInfo(remote) }),
    exec: async (_command, args) => {
      commands.push(args);
      if (args[0] === "check-ref-format") return { code: 0, stdout: "feature-test" };
      if (args[0] === "remote" && args.length === 1) return { code: 0, stdout: "other\norigin" };
      if (args[0] === "remote") return { code: 0, stdout: `git@${args[2] === "other" ? "other.example" : "code.example"}:${repo}.git` };
      if (args[0] === "show-ref") return { code: 1, stdout: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: sha };
      return { code: 0, stdout: "" };
    },
  });
  const pr = { ...model.normalizeMergeRequest(row, repo, provider), provider };
  const state = { ...worktreeMethods, settings: { worktrees: { root: "/worktrees" } },
    worktreeForm: { pr, repo, sp: { folder: "/checkout" }, branch: { value: () => "feature-test" }, name: { value: () => "MR-12" } },
    api: async r => { assert.deepEqual(r.provider, provider); return { headRefOid: sha }; },
    openWorktree(form) { form.opened = true; } };
  state.createWorktree(cx); await Promise.all(cx.tasks);
  assert.equal(state.worktreeForm.error, null);
  const fetch = commands.find(args => args[0] === "fetch");
  assert.equal(fetch.at(-1), "refs/merge-requests/12/head");
  assert.match(fetch.at(-2), /^git@code.example:/);
  assert.equal(commands.find(args => args[0] === "worktree").at(-1), sha);
  const binding = providerFns.decodeBinding(commands.find(args => args[0] === "config").at(-1));
  assert.deepEqual(binding.provider, provider);
  assert.match(state.worktreeForm.path, /gitlab-code.example\/group-sub-project\/MR-12$/);
});

test("a pending merge keeps its provider and expected head when the selected remote changes", async () => {
  const { changeMethods } = await moduleAt("../mods/xmux-branch-pr/actions/changes.js", ["changeMethods"], {
    ...providerFns, STATE_CHANGES: { merge: { done: "Merged." } },
  });
  const calls = [], cx = context();
  const state = { ...changeMethods, pr: model.normalizeMergeRequest(row, repo, provider), spaceKey: "space",
    api: async request => { calls.push(request); }, openPR: (...args) => calls.push(args) };
  state.askStateChange("merge", cx);
  state.provider = { kind: "github", host: "github.com" };
  state.changeState(cx); await Promise.all(cx.tasks);
  assert.deepEqual(calls[0].provider, provider);
  assert.equal(calls[0].head, sha);
  assert.deepEqual(calls[1][3], provider);
});

test("branch aggregation keeps same-path repositories on separate hosts and never deduplicates by provider-local ID", async () => {
  const { discoveryMethods } = await moduleAt("../mods/xmux-branch-pr/github/discovery.js", ["discoveryMethods"], {
    ...providerFns, exec: async (_command, args) => args[0] === "symbolic-ref" ? { code: 0, stdout: "feature" } : { code: 1, stdout: "" },
  });
  const cx = context();
  const remotes = [{ name: "a", repo, provider: "gitlab", host: "one.example" }, { name: "b", repo, provider: "gitlab", host: "two.example" }];
  const state = { ...discoveryMethods, sp: { folder: "/repo" }, spaceKey: "space", settings: {}, branchToken: 0,
    discoverRemotes: async () => remotes,
    api: async r => ({ items: [{ ...model.normalizeMergeRequest(row, repo, r.provider), provider: r.provider }] }),
    openSoleBranchPR() {} };
  state.loadBranchPRs(cx); await Promise.all(cx.tasks);
  assert.equal(state.branchPRs.length, 2);
  assert.notEqual(providerFns.requestKey(state.branchPRs[0]), providerFns.requestKey(state.branchPRs[1]));
});

test("sidebar MR status uses detailed GitLab merge state rather than the older coarse state", async () => {
  const { prAppearance } = await moduleAt("../mods/xmux-sidebar/git/pr-status.js", ["prAppearance"]);
  const colors = { ansi1: "red", ansi2: "green", ansi3: "yellow", ansi5: "purple", dim: "gray" };
  const pr = model.normalizeMergeRequest({ ...row, merge_status: "can_be_merged", detailed_merge_status: "requested_changes" }, repo, provider);
  const status = prAppearance(pr, colors);
  assert.equal(status.label, "Changes requested");
  assert.ok(!status.ready);
});

test("GraphQL read retry opt-in cannot replay a mutation", async () => {
  const calls = [];
  const { hostingApi } = await moduleAt("../lib/xmux/hosting.js", ["hostingApi"], { home: () => "/home/me", exec: async (_command, args) => {
    calls.push(args);
    return { code: 1, stdout: "", stderr: "HTTP 503" };
  } });
  const p = { kind: "github", host: "enterprise.example" };
  await assert.rejects(hostingApi(p, "graphql", { method: "POST", fields: { query: "mutation { change }" }, readOnly: true, tools: { github: "/custom/gh" } }), /503/);
  assert.equal(calls.length, 1);
  await assert.rejects(hostingApi(p, "graphql", { method: "POST", fields: { query: "query { viewer { login } }" }, readOnly: true, tools: { github: "/custom/gh" } }), /503/);
  assert.equal(calls.length, 3);
});

test("non-list pagination data is an error rather than an empty success", async () => {
  const { apiPages } = await moduleAt("../lib/xmux/hosting.js", ["apiPages"], { home: () => "/home/me", exec: async () => ({ code: 0, stdout: '{"message":"unexpected"}' }) });
  await assert.rejects(apiPages(provider, "projects/8/merge_requests/12/diffs", { tools: { gitlab: "/custom/glab" } }), /Unexpected paginated/);
});

test("the GitHub helper retries transient read failures but never retries a write", async () => {
  let calls = 0;
  const { githubApi } = await moduleAt("../mods/xmux-branch-pr/github/cli.js", ["githubApi"], {
    ...providerFns, cliPath: async () => "/gh", appHome: () => "/app", transient: text => /EOF/.test(text),
    exec: async () => { calls++; return calls === 1 ? { code: 1, stdout: '{"error":"EOF"}' } : { code: 0, stdout: '{"items":[]}' }; },
  });
  const p = { kind: "github", host: "github.com" };
  await githubApi({ action: "branch", repo: "a/b" }, null, p);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(githubApi({ action: "comment", repo: "a/b", number: 1, body: "x" }, null, p), /EOF/);
  assert.equal(calls, 1);
});

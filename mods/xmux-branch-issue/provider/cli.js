// Provider adapters for Branch Issue. All credentials remain in gh/glab.
import { cliExec } from "../shared/hosting.js";
import { cliName } from "../shared/hosting-cli.js";
import { providerHost, providerName, repositoryTarget, repositoryUrl } from "../shared/provider.js";

const person = (u) => u?.login || u?.username || u?.user_name || u?.name || "";
const iso = (v) => v || new Date().toISOString();
function state(value) {
  const v = String(value || "open").toLowerCase();
  return v === "merged" ? { id: "merged", name: "Merged", type: "completed", color: "#8957e5" }
    : v === "closed" ? { id: "closed", name: "Closed", type: "canceled", color: "#8b949e" }
      : { id: "open", name: "Open", type: "started", color: "#2da44e" };
}
const team = (provider, assignees = []) => ({
  key: provider?.kind || "repo", name: providerName(provider),
  states: [state("open"), state("closed")],
  members: assignees.map((a) => ({ id: person(a), name: person(a), active: true })),
});

export function normalizeIssue(row, repo, provider) {
  const number = Number(row.number ?? row.iid ?? row.id ?? 0);
  const assignees = row.assignees || row.assignee ? (row.assignees || [row.assignee]).filter(Boolean) : [];
  const comments = (row.comments || row.notes || []).map((c) => ({
    id: String(c.id ?? `${number}-${c.createdAt}`), body: c.body || c.note || "", url: c.url || c.web_url || row.url,
    createdAt: iso(c.createdAt || c.created_at), user: { name: person(c.author || c.author_user || c.user) },
  }));
  const url = repositoryUrl(provider, repo);
  const issuePath = provider?.kind === "gitlab" ? "-/issues" : "issues";
  return {
    ...row, id: String(row.id ?? `${repo}#${number}`), number, identifier: String(number), author: { login: person(row.author) },
    title: row.title || `Issue #${number}`, url: row.url || row.web_url || `${url}/${issuePath}/${number}`,
    description: row.body || row.description || "", body: row.body || row.description || "",
    state: state(row.state), priority: 0, priorityLabel: "No priority", assignee: assignees[0] ? { id: person(assignees[0]), name: person(assignees[0]) } : null,
    labels: (row.labels || []).map((l) => ({ id: l.id || l.name, name: l.name || String(l) })),
    comments, children: [], attachments: [], project: null, cycle: null, estimate: null,
    createdAt: iso(row.createdAt || row.created_at), updatedAt: iso(row.updatedAt || row.updated_at),
    branchName: `issue-${number}-${String(row.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 45)}`,
    team: team(provider, assignees), providerName: providerName(provider),
  };
}

export async function providerApi(request, sp, provider) {
  const repo = request.repo || provider?.repo;
  if (!provider || !repo) throw new Error("No GitHub or GitLab remote found for this directory.");
  const isGitLab = provider.kind === "gitlab";
  const target = isGitLab ? repositoryUrl(provider, repo) : repositoryTarget(provider, repo);
  const host = providerHost(provider);
  const run = (args) => cliExec(provider.kind, args, {
    tools: request.tools,
    host,
    cwd: sp?.machine ? undefined : sp?.folder,
    read: false,
  });
  async function json(args) {
    const result = await run(args);
    try { return JSON.parse(result.stdout || "null"); }
    catch { throw new Error(`${cliName(provider.kind)} returned invalid JSON.`); }
  }
  const viewer = () => json(["api", "--hostname", host, "user"]);
  if (isGitLab) {
    if (request.action === "list") {
      const args = ["issue", "list", "--repo", target, "--per-page", "100", "--output", "json"];
      if (request.state === "done" || request.state === "cancelled") args.push("--closed");
      if (request.state === "all") args.push("--all");
      if (request.search) args.push("--search", request.search);
      const rows = await json(args);
      let items = (Array.isArray(rows) ? rows : []).map((r) => normalizeIssue(r, repo, provider));
      if (request.scope === "mine") { const me = person(await viewer()); items = items.filter((i) => i.author?.login === me || i.assignee?.id === me); }
      return { items, cursor: "" };
    }
    if (request.action === "detail") {
      const row = await json(["issue", "view", String(request.identifier), "--repo", target, "--output", "json"]);
      return normalizeIssue(row, repo, provider);
    }
    if (request.action === "comment") { await run(["issue", "note", String(request.issue), "--repo", target, "--message", request.body || ""]); return { ok: true }; }
    if (request.action === "update") {
      if (request.stateId === "closed") await run(["issue", "close", String(request.issue), "--repo", target]);
      if (request.stateId === "open") await run(["issue", "reopen", String(request.issue), "--repo", target]);
      if (request.assignee || request.unassign) await run(["issue", "update", String(request.issue), "--repo", target, ...(request.unassign ? ["--assignee", ""] : ["--assignee", request.assignee])]);
      return { issue: await providerApi({ action: "detail", identifier: request.issue, repo, tools: request.tools }, sp, provider) };
    }
    if (request.action === "viewer") return { viewer: await viewer(), teams: [] };
  } else {
    if (request.action === "list") {
      const stateArg = request.state === "done" || request.state === "cancelled" ? "closed" : request.state === "all" ? "all" : "open";
      const args = ["issue", "list", "--repo", target, "--state", stateArg, "--limit", String(Math.min(100, request.pageSize || 100)), "--json", "number,title,url,state,author,assignees,labels,createdAt,updatedAt,body"];
      if (request.search) args.push("--search", request.search);
      const rows = await json(args);
      let items = (Array.isArray(rows) ? rows : []).map((r) => normalizeIssue(r, repo, provider));
      if (request.scope === "mine") { const me = person(await viewer()); items = items.filter((i) => i.author?.login === me || i.assignee?.id === me); }
      return { items, cursor: "" };
    }
    if (request.action === "detail") {
      const row = await json(["issue", "view", String(request.identifier), "--repo", target, "--json", "number,title,url,state,author,assignees,labels,createdAt,updatedAt,body,comments"]);
      return normalizeIssue(row, repo, provider);
    }
    if (request.action === "comment") { await run(["issue", "comment", String(request.issue), "--repo", target, "--body", request.body || ""]); return { ok: true }; }
    if (request.action === "update") {
      if (request.stateId === "closed") await run(["issue", "close", String(request.issue), "--repo", target]);
      if (request.stateId === "open") await run(["issue", "reopen", String(request.issue), "--repo", target]);
      if (request.assignee) await run(["issue", "edit", String(request.issue), "--repo", target, "--add-assignee", request.assignee]);
      if (request.unassign) await run(["issue", "edit", String(request.issue), "--repo", target, "--remove-assignee", "@me"]);
      return { issue: await providerApi({ action: "detail", identifier: request.issue, repo, tools: request.tools }, sp, provider) };
    }
    if (request.action === "viewer") return { viewer: await viewer(), teams: [] };
  }
  throw new Error(`Unsupported ${provider.kind} issue operation: ${request.action}`);
}

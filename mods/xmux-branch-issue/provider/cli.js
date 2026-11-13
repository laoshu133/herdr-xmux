// Provider adapters for Branch Issue. All credentials remain in gh/glab.
import { exec } from "herdr";

const opts = (sp) => ({ cwd: sp?.machine ? undefined : sp?.folder, on: sp?.machine });
const project = (p, repo) => `${p?.host || "gitlab.com"}/${repo}`;

function failure(result, tool) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  if (/command not found|(?:exec:\s*)?(?:gh|glab): not found|no such file/i.test(text))
    throw new Error(`${tool} CLI is not installed. Install ${tool}, then run \`${tool} auth login\`.`);
  if (/not logged|not authenticated|authentication required|unauthorized|401|authentication failed/i.test(text))
    throw new Error(`${tool} CLI is not logged in. Run \`${tool} auth login\` in a terminal, then refresh.`);
  throw new Error(text || `${tool} request failed.`);
}

async function run(tool, args, sp) {
  const result = await exec(tool, args, opts(sp));
  if (result.code !== 0) failure(result, tool);
  return result;
}
async function json(tool, args, sp) {
  const result = await run(tool, args, sp);
  try { return JSON.parse(result.stdout || "null"); } catch { throw new Error(`${tool} returned invalid JSON.`); }
}

const person = (u) => u?.login || u?.username || u?.user_name || u?.name || "";
const iso = (v) => v || new Date().toISOString();
function state(value) {
  const v = String(value || "open").toLowerCase();
  return v === "merged" ? { id: "merged", name: "Merged", type: "completed", color: "#8957e5" }
    : v === "closed" ? { id: "closed", name: "Closed", type: "canceled", color: "#8b949e" }
      : { id: "open", name: "Open", type: "started", color: "#2da44e" };
}
const team = (provider, assignees = []) => ({
  key: provider?.kind || "repo", name: provider?.kind === "gitlab" ? "GitLab" : "GitHub",
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
  const providerName = provider?.kind === "gitlab" ? "GitLab" : "GitHub";
  return {
    ...row, id: String(row.id ?? `${repo}#${number}`), number, identifier: String(number), author: { login: person(row.author) },
    title: row.title || `Issue #${number}`, url: row.url || row.web_url || `https://${provider?.host || "github.com"}/${repo}/issues/${number}`,
    description: row.body || row.description || "", body: row.body || row.description || "",
    state: state(row.state), priority: 0, priorityLabel: "No priority", assignee: assignees[0] ? { id: person(assignees[0]), name: person(assignees[0]) } : null,
    labels: (row.labels || []).map((l) => ({ id: l.id || l.name, name: l.name || String(l) })),
    comments, children: [], attachments: [], project: null, cycle: null, estimate: null,
    createdAt: iso(row.createdAt || row.created_at), updatedAt: iso(row.updatedAt || row.updated_at),
    branchName: `issue-${number}-${String(row.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 45)}`,
    team: team(provider, assignees), providerName,
  };
}

export async function providerApi(request, sp, provider) {
  const repo = request.repo || provider?.repo;
  if (!provider || !repo) throw new Error("No GitHub or GitLab remote found for this directory.");
  const isGitLab = provider.kind === "gitlab";
  if (isGitLab) {
    const target = project(provider, repo);
    if (request.action === "list") {
      const stateArg = request.state === "done" || request.state === "cancelled" ? "closed" : request.state === "all" ? "all" : "opened";
      const args = ["--repo", target, "issue", "list", "--state", stateArg, "--per-page", "100", "--output", "json"];
      if (request.search) args.push("--search", request.search);
      const rows = await json("glab", args, sp);
      let items = (Array.isArray(rows) ? rows : []).map((r) => normalizeIssue(r, repo, provider));
      if (request.scope === "mine") { const me = person(await json("glab", ["--repo", target, "api", "user"], sp)); items = items.filter((i) => i.author?.login === me || i.assignee?.id === me); }
      return { items, cursor: "" };
    }
    if (request.action === "detail") {
      const row = await json("glab", ["--repo", target, "issue", "view", String(request.identifier), "--output", "json"], sp);
      return normalizeIssue(row, repo, provider);
    }
    if (request.action === "comment") { await run("glab", ["--repo", target, "issue", "note", String(request.issue), "--message", request.body || ""], sp); return { ok: true }; }
    if (request.action === "update") {
      if (request.stateId === "closed") await run("glab", ["--repo", target, "issue", "close", String(request.issue)], sp);
      if (request.stateId === "open") await run("glab", ["--repo", target, "issue", "reopen", String(request.issue)], sp);
      if (request.assignee || request.unassign) await run("glab", ["--repo", target, "issue", "update", String(request.issue), ...(request.unassign ? ["--assignee", ""] : ["--assignee", request.assignee])], sp);
      return { issue: await providerApi({ action: "detail", identifier: request.issue, repo }, sp, provider) };
    }
    if (request.action === "viewer") return { viewer: await json("glab", ["--repo", target, "api", "user"], sp), teams: [] };
  } else {
    if (request.action === "list") {
      const stateArg = request.state === "done" || request.state === "cancelled" ? "closed" : request.state === "all" ? "all" : "open";
      const args = ["issue", "list", "--repo", repo, "--state", stateArg, "--limit", String(Math.min(100, request.pageSize || 100)), "--json", "number,title,url,state,author,assignees,labels,createdAt,updatedAt,body"];
      if (request.search) args.push("--search", request.search);
      const rows = await json("gh", args, sp);
      let items = (Array.isArray(rows) ? rows : []).map((r) => normalizeIssue(r, repo, provider));
      if (request.scope === "mine") { const me = person(await json("gh", ["api", "user"], sp)); items = items.filter((i) => i.author?.login === me || i.assignee?.id === me); }
      return { items, cursor: "" };
    }
    if (request.action === "detail") {
      const row = await json("gh", ["issue", "view", String(request.identifier), "--repo", repo, "--json", "number,title,url,state,author,assignees,labels,createdAt,updatedAt,body,comments"], sp);
      return normalizeIssue(row, repo, provider);
    }
    if (request.action === "comment") { await run("gh", ["issue", "comment", String(request.issue), "--repo", repo, "--body", request.body || ""], sp); return { ok: true }; }
    if (request.action === "update") {
      if (request.stateId === "closed") await run("gh", ["issue", "close", String(request.issue), "--repo", repo], sp);
      if (request.stateId === "open") await run("gh", ["issue", "reopen", String(request.issue), "--repo", repo], sp);
      if (request.assignee) await run("gh", ["issue", "edit", String(request.issue), "--repo", repo, "--add-assignee", request.assignee], sp);
      if (request.unassign) await run("gh", ["issue", "edit", String(request.issue), "--repo", repo, "--remove-assignee", "@me"], sp);
      return { issue: await providerApi({ action: "detail", identifier: request.issue, repo }, sp, provider) };
    }
    if (request.action === "viewer") return { viewer: await json("gh", ["api", "user"], sp), teams: [] };
  }
  throw new Error(`Unsupported ${provider.kind} issue operation: ${request.action}`);
}

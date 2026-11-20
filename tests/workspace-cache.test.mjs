import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as hostingCli from "../lib/xmux/hosting-cli.js";

async function moduleAt(path, names, deps = {}, clock = Date) {
  const source = (await readFile(new URL(path, import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export (?:default )?/gm, "");
  return new Function("deps", "Date", `const { ${Object.keys(deps).join(",")} } = deps;\n${source}\nreturn {${names.join(",")}};`)(deps, clock);
}

test("PRs and the sidebar use the same CLI and host overrides", async () => {
  const files = new Map([
    ["/app/mods/xmux-branch-pr/mod.json", JSON.stringify({ settings: {
      refresh: { every: "25s" }, tools: { github: "/global/gh", gitlab: "/global/glab" }, hosts: [],
    } })],
    ["/app/data/xmux-branch-pr/settings.json", JSON.stringify({
      tools: { gitlab: "/local/glab" }, hosts: [{ remote: "git-alias", kind: "gitlab", host: "code.example" }],
    })],
  ]);
  const { loadSettings } = await moduleAt("../lib/xmux/settings.js", ["loadSettings"], {
    appHome: () => "/app", readTextFile: async (path) => files.get(path) ?? null,
  });
  const { loadPRSettings } = await moduleAt("../lib/xmux/pr-settings.js", ["loadPRSettings"], { loadSettings });
  const panel = await loadPRSettings({ refresh: { every: "60s" } });
  const sidebar = await loadPRSettings();
  assert.deepEqual(panel.problems, []);
  assert.deepEqual(panel.settings.refresh, { every: "25s" });
  assert.deepEqual(panel.settings.tools, { github: "/global/gh", gitlab: "/local/glab" });
  assert.deepEqual(sidebar.settings, { tools: panel.settings.tools, hosts: panel.settings.hosts });
  assert.equal(sidebar.settings.hosts[0].host, "code.example");

  files.set("/app/data/xmux-branch-pr/settings.json", '{"hosts":{} }');
  const invalid = await loadPRSettings();
  assert.ok(invalid.problems.includes("hosts should be an array"));
  assert.deepEqual(invalid.settings.hosts, []);
});

test("the tab bar reserves only the space still occupied by macOS controls", async () => {
  const { tabBarInset } = await moduleAt("../mods/xmux-tabs/views/tab-bar.js", ["tabBarInset"]);
  const sidebar = { id: "sidebar", size: { px: 48 } };
  const layout = { traffic_lights: [12, 11], children: [sidebar] };
  const window = { platform: "macos", titlebar: "none", fullscreen: false };
  assert.equal(tabBarInset(layout, window), 28);
  assert.equal(tabBarInset(layout, window, 0.8), 47);
  sidebar.hidden = true;
  assert.equal(tabBarInset(layout, window), 76);
  assert.equal(tabBarInset(layout, { ...window, fullscreen: true }), 0);
  assert.equal(tabBarInset(layout, { ...window, platform: "linux" }), 0);
});

test("Go to searches machine-qualified spaces and focuses the matched split Agent", async () => {
  const program = { name: "Codex", key: "codex", agent: true };
  const first = { pane: "p1", tab: "t", terminal: "m5/t1", program, title: "Review docs | XMux" };
  const second = { pane: "p2", tab: "t", terminal: "m5/t2", program, title: "Fix split shortcuts | XMux" };
  const agents = [first, second].map((pane) => ({ ...pane, address: pane.terminal, status: "working" }));
  const spaces = [{ id: "s", name: "herdr-xmux", machine: "m5", status: "working",
    tabs: [{ id: "t", name: "1", active: true }] }];
  const commands = [];
  const titles = await moduleAt("../lib/xmux/tab-title.js", ["automaticTabTitle", "tabLead"], { terminals: () => [] });
  const { Picker } = await moduleAt("../mods/xmux-picker/main.js", ["Picker"], {
    ...titles, View: class {}, spaces: () => spaces, panes: () => [first, second], focused: () => first,
    agents: () => agents, terminals: () => [], shared: () => null, run: (...args) => commands.push(args),
  });
  const picker = new Picker();
  Object.assign(picker, { filter: "m5/herdr-xmux", localHost: "Mi-M2", machines: [], close() {} });
  const matching = picker.rows().filter((row) => row.kind === "head" || row.kind === "ctx");
  assert.deepEqual(matching.map((row) => row.title ?? row.label), ["m5/herdr-xmux", "Review docs", "Fix split shortcuts"]);
  picker.filter = "split shortcuts";
  const [target] = picker.rows().filter((row) => row.kind === "ctx");
  picker.go(target);
  assert.deepEqual(commands, [["pane.focus", { pane: "p2" }]]);
});

test("sidebar mode routes the navigation keys to workspace tabs or native Agent order", async () => {
  let tab = "spaces";
  const calls = [];
  const { WorkspaceStatus } = await moduleAt("../mods/xmux-status/main.js", ["WorkspaceStatus"], {
    View: class {}, shared: () => ({ tab }), run: (...args) => calls.push(args),
  });
  const status = new WorkspaceStatus();
  status.crossTab = direction => calls.push(["cross-tab", direction]);
  status.navigate(-1);
  tab = "agents";
  status.navigate(-1);
  status.navigate(1);
  assert.deepEqual(calls, [["cross-tab", -1], ["agent.prev"], ["agent.next"]]);
});

test("sidebar aliases are stable per machine across sorting, exits and reconnects", async () => {
  const { assignAgentAliases } = await moduleAt("../mods/xmux-sidebar/views/agents.js", ["assignAgentAliases"]);
  const list = (...addresses) => addresses.map((address) => ({ address }));
  const original = assignAgentAliases({}, list("m5/t26", "t40", "mi-ber/t26", "m5/t21"));
  assert.deepEqual(original, {
    "m5/1": "m5/t26", "1": "t40", "mi-ber/1": "mi-ber/t26", "m5/2": "m5/t21",
  });
  assert.equal(assignAgentAliases(original, list("m5/t21", "m5/t26", "t40")), original);

  const updated = assignAgentAliases(original, list("m5/t30", "m5/t21", "t42"));
  assert.deepEqual(updated, { ...original, "m5/3": "m5/t30", "2": "t42" });
  assert.equal(assignAgentAliases(updated, list("mi-ber/t26", "m5/t30")), updated);
});

test("attention follows sidebar order and waits for every blocked Agent to clear", async () => {
  const agents = [
    { address: "done", status: "done" },
    { address: "a", status: "blocked" },
    { address: "b", status: "blocked" },
  ];
  const child = { address: "child", parent: "b", state: "live", status: "blocked" };
  const order = ["done", "b", "a"];
  const calls = [];
  const { WorkspaceStatus } = await moduleAt("../mods/xmux-status/main.js", ["WorkspaceStatus"], {
    View: class {}, agents: () => agents, terminals: () => [child], shared: () => ({ order }),
    run: (_command, { terminal }) => calls.push(terminal), notify: ({ title }) => calls.push(title),
  });
  const status = new WorkspaceStatus();
  status.focusAttention();
  status.focusAttention();
  agents[2].status = "working";
  status.focusAttention();
  child.status = "idle";
  status.focusAttention();
  agents[1].status = "idle";
  status.focusAttention();
  agents[0].status = "idle";
  status.focusAttention();
  assert.deepEqual(calls, ["b", "b", "child", "a", "done", "No agents need attention"]);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

async function contextFixture() {
  const data = new Map(), calls = [];
  const state = {
    spaces: [{ id: "local", folder: "/home", active: true,
      tabs: [{ id: "shell" }, { id: "preview", active: true }] },
      { id: "remote", machine: "server", folder: "", tabs: [{ id: "remote-shell" }] }],
    panes: [{ pane: "p1", tab: "shell", cwd: "/work/project", branch: "main" },
      { pane: "preview-pane", tab: "preview", mod: "xmux-files" },
      { pane: "rp", tab: "remote-shell", cwd: "/remote/project" }],
    focused: { pane: "preview-pane", tab: "preview" },
  };
  const api = await moduleAt("../lib/xmux/context.js", ["terminalDirectory", "spaceDirectory", "activeWorkspace", "workspaceKey", "rememberRoot", "knownRoot", "openTerminalTab", "splitTerminal"], {
    spaces: () => state.spaces, panes: () => state.panes, focused: () => state.focused,
    shared: k => data.get(k), setShared: (k, v) => data.set(k, v),
    run: (...args) => calls.push(args),
  });
  return { ...api, state, data, calls };
}

test("preview terminal creation uses its space project, including remote spaces", async () => {
  const f = await contextFixture();
  f.openTerminalTab();
  assert.deepEqual(f.calls[0], ["tab.new", { space: "local", folder: "/work/project" }]);
  f.openTerminalTab(f.state.spaces[1]);
  assert.deepEqual(f.calls[1], ["tab.new", { space: "remote", folder: "/remote/project" }]);
});

test("a focused terminal keeps its exact subdirectory; a preview uses the known project root", async () => {
  const f = await contextFixture();
  f.state.spaces[0].tabs = [{ id: "shell", active: true }];
  f.state.panes[0].cwd = "/work/project/src";
  f.state.focused = f.state.panes[0];
  f.rememberRoot("/work/project/src", "/work/project", null);
  assert.equal(f.terminalDirectory(f.state.spaces[0]), "/work/project/src");
  f.state.spaces[0].tabs.push({ id: "preview", active: true });
  f.state.spaces[0].tabs[0].active = false;
  assert.equal(f.terminalDirectory(f.state.spaces[0]), "/work/project");
});

test("workspace identity survives preview tabs and stays isolated by machine", async () => {
  const f = await contextFixture();
  f.state.spaces[0].tabs = [{ id: "shell", active: true }, { id: "preview" }];
  const before = f.workspaceKey(f.activeWorkspace());
  f.state.spaces[0].tabs[0].active = false;
  f.state.spaces[0].tabs[1].active = true;
  assert.equal(f.workspaceKey(f.activeWorkspace()), before);
  f.rememberRoot("/same/src", "/same", "server");
  assert.equal(f.knownRoot("/same/src", null), "/same/src");
  assert.equal(f.knownRoot("/same/nested", "server"), "/same/nested");
});

test("preview split and an unfocused header target resolve the owning space", async () => {
  const f = await contextFixture();
  f.splitTerminal("right");
  assert.deepEqual(f.calls, [["pane.focus", { pane: "preview-pane" }],
    ["terminal.open", { place: "right", folder: "/work/project" }]]);
  f.calls.length = 0;
  f.splitTerminal("down", "rp");
  assert.deepEqual(f.calls, [["pane.focus", { pane: "rp" }],
    ["terminal.open", { place: "down", folder: "/remote/project" }]]);
});

test("spaces with no terminal still use their persisted directory, never another space", async () => {
  const f = await contextFixture();
  f.state.panes = f.state.panes.slice(1);
  assert.equal(f.terminalDirectory(f.state.spaces[0]), "/home");
  f.state.spaces[0].tabs = [];
  f.state.panes.push({ cwd: "/wrong", focused: true });
  assert.equal(f.terminalDirectory(f.state.spaces[0]), "/home");
});

async function cacheFixture(data = new Map()) {
  let now = 1000;
  const api = await moduleAt("../lib/xmux/query-cache.js", ["cachedQuery", "peekQuery", "invalidateQueries", "configureQueries", "queryKey", "panelShown"], {
    shared: k => data.get(k), setShared: (k, v) => data.set(k, v),
  }, { now: () => now });
  api.configureQueries({ timer: { after: (_ms, cb) => setTimeout(cb, 1) } });
  return { ...api, data, tick: ms => { now += ms; } };
}

test("cache joins simultaneous reads, hits inside TTL, and expires", async () => {
  const f = await cacheFixture(), gate = deferred();
  let count = 0;
  const load = () => { count++; return gate.promise; };
  const a = f.cachedQuery("repo", 100, load), b = f.cachedQuery("repo", 100, load);
  gate.resolve({ value: 1 });
  assert.strictEqual(await a, await b);
  assert.equal(count, 1);
  assert.deepEqual(await f.cachedQuery("repo", 100, () => { throw Error("unexpected read"); }), { value: 1 });
  f.tick(101);
  assert.equal(await f.cachedQuery("repo", 100, () => ++count), 2);
});

test("invalidating a pending read prevents it from replacing newer post-write data", async () => {
  const f = await cacheFixture(), gate = deferred();
  const old = f.cachedQuery("repo", 100, () => gate.promise);
  await Promise.resolve();
  f.invalidateQueries(k => k === "repo");
  assert.equal(await f.cachedQuery("repo", 100, () => "new"), "new");
  gate.resolve("old"); await old;
  assert.equal(f.peekQuery("repo"), "new");
});

test("failure backoff retains last good data; explicit refresh bypasses backoff", async () => {
  const f = await cacheFixture();
  await f.cachedQuery("repo", 100, () => "good");
  f.tick(101);
  await assert.rejects(f.cachedQuery("repo", 100, () => { throw Error("offline"); }), /offline/);
  assert.equal(f.peekQuery("repo"), "good");
  await assert.rejects(f.cachedQuery("repo", 100, () => "unexpected"), /offline/);
  assert.equal(await f.cachedQuery("repo", 100, () => "recovered", { force: true }), "recovered");
});

test("metadata is coalesced across runtimes and a dead owner expires", async () => {
  const data = new Map(), a = await cacheFixture(data), b = await cacheFixture(data), gate = deferred();
  const first = a.cachedQuery("meta", 100, () => gate.promise, { share: true });
  await Promise.resolve();
  let duplicates = 0;
  const second = b.cachedQuery("meta", 100, () => { duplicates++; return "duplicate"; }, { share: true });
  gate.resolve("shared");
  assert.equal(await first, "shared");
  assert.equal(await second, "shared");
  assert.equal(duplicates, 0);
  data.set("xmux.query-metadata.v1", { dead: { owner: "dead", until: 999 } });
  assert.equal(await b.cachedQuery("dead", 100, () => "reclaimed", { share: true }), "reclaimed");
});

test("oversized metadata releases its lease and API data stays runtime-local", async () => {
  const f = await cacheFixture();
  await f.cachedQuery("large", 100, () => "x".repeat(33000), { share: true });
  assert.equal(f.data.get("xmux.query-metadata.v1").large.owner, undefined);
  await f.cachedQuery("private", 100, () => ({ secret: "private payload" }));
  assert.equal(f.data.get("xmux.query-metadata.v1").private, undefined);
});

test("stable query keys merge equivalent requests; visibility respects stack selection", async () => {
  const f = await cacheFixture();
  assert.equal(f.queryKey({ repo: "a", action: "detail", number: 1 }), f.queryKey({ number: 1, repo: "a", action: "detail" }));
  const tree = { type: "stack", active: "pr", children: [
    { id: "changes", content: { mod: "xmux-changes" } }, { id: "pr", content: { mod: "xmux-branch-pr" } }] };
  assert.equal(f.panelShown(tree, "xmux-changes"), false);
  assert.equal(f.panelShown(tree, "xmux-branch-pr"), true);
  assert.equal(f.panelShown({ ...tree, hidden: true }, "xmux-branch-pr"), false);
});

test("decorated text preserves whitespace and escapes code instead of interpreting HTML", async () => {
  const t = { ansi1: "#ff0000", ansi2: "#00ff00", accent: "#0088ff", foreground: "#ffffff", raised: "#222222" };
  const f = await moduleAt("../lib/xmux/code-viewer.js", ["columnHtml"], { theme: () => t });
  const text = '\t  <img src="private"> & 中文  ';
  const html = f.columnHtml([{ kind: "+", text }, { kind: " ", text: "" }, { kind: "-", text: "next" }]);
  assert.ok(!html.includes("<img"));
  const decode = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  // Herdr minifies by parsing, then writes <pre> text raw and parses again.
  const decoded = decode(decode(html.replace(/<[^>]+>/g, "")));
  assert.equal(decoded, text + "\n\nnext");
});

test("peek keys match actual PR and Issue API calls", async () => {
  for (const path of ["../mods/xmux-branch-pr/github/reads.js", "../mods/xmux-branch-issue/provider/reads.js"]) {
    const cache = await cacheFixture();
    const { readMethods } = await moduleAt(path, ["readMethods"], { queryKey: cache.queryKey });
    const state = { ...readMethods, sp: { machine: "server" }, provider: { kind: "github", host: "github.com", repo: "a/b" }, settings: { tools: { github: "gh" } } };
    const request = { action: "detail", repo: "a/b", number: 1 };
    assert.equal(state.apiKey(request), state.apiKey({ tools: state.settings.tools, ...request, provider: state.provider }));
  }
});

test("PR reads use local hosting credentials, coalesce, and invalidate after a write", async () => {
  const cache = await cacheFixture();
  const calls = [];
  const { readMethods } = await moduleAt("../mods/xmux-branch-pr/github/reads.js", ["readMethods"], {
    ...cache,
    githubApi: async (request, _sp, provider) => {
      calls.push({ request, options: { on: null, cwd: undefined }, provider });
      return { number: request.number, revision: calls.length };
    },
  });
  const state = { ...readMethods, sp: { machine: "server", folder: "/remote/repo" },
    provider: { kind: "github", host: "github.com", repo: "owner/repo" }, settings: { tools: {} } };
  const request = { action: "detail", number: 1 };
  await Promise.all([state.api(request), state.api(request)]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.on, null);
  assert.equal(calls[0].options.cwd, undefined);
  await state.api({ action: "comment", number: 1, body: "test" });
  const fresh = await state.api(request);
  assert.equal(fresh.revision, 3);
  state.provider = { ...state.provider, host: "enterprise.example" };
  await state.api(request);
  assert.equal(calls.length, 4);
});

test("an Issue viewer response cannot change identity after navigation", async () => {
  const { readMethods } = await moduleAt("../mods/xmux-branch-issue/provider/reads.js", ["readMethods"]);
  const gate = deferred();
  const state = { ...readMethods, spaceKey: "old", me: null, api: () => gate.promise };
  const pending = state.ensureViewer();
  state.spaceKey = "new";
  gate.resolve({ viewer: "old-account", teams: ["old-team"] });
  await pending;
  assert.equal(state.me, null);
  assert.equal(state.teams, undefined);
});

test("provider discovery checks installed CLIs, their host login, and the repository", async () => {
  const cache = await cacheFixture();
  const calls = [];
  const f = await moduleAt("../lib/xmux/provider.js", ["resolveProvider"], { ...cache, ...hostingCli, home: () => "/home/me",
    exec: async (tool, args, options) => {
      calls.push({ tool, args, options });
      if (args[0] === "--version") return { code: 0, stdout: tool };
      if (args[0] === "auth") return { code: tool === "gh" ? 0 : 1 };
      return { code: 0, stdout: '{"full_name":"A/B"}' };
    },
  });
  const explicit = { remote: "git-alias", kind: "gitlab", host: "code.example" };
  assert.deepEqual(await f.resolveProvider("git@git-alias:a/b.git", { hosts: [explicit] }),
    { kind: "gitlab", host: "code.example", repo: "a/b" });
  assert.equal(calls.length, 0);
  const remote = "git@gitlab.example:a/b.git";
  const resolved = { kind: "github", host: "gitlab.example", repo: "A/B" };
  assert.deepEqual(await Promise.all([f.resolveProvider(remote), f.resolveProvider(remote)]), [resolved, resolved]);
  assert.deepEqual(calls.filter(({ args }) => args[0] === "--version").map(({ tool }) => tool), ["gh", "glab"]);
  assert.equal(calls.filter(({ args }) => args.join(" ") === "auth status --hostname gitlab.example").length, 2);
  const queries = calls.filter(({ args }) => args[0] === "api");
  assert.deepEqual(queries.map(({ tool, args }) => [tool, ...args]), [["gh", "api", "--hostname", "gitlab.example", "repos/a/b"]]);
  assert.ok(calls.every(({ options }) => options.on === null));
});

test("GitLab discovery uses exact host authorization and verifies the full project namespace", async () => {
  const cache = await cacheFixture();
  const calls = [];
  const { resolveProvider } = await moduleAt("../lib/xmux/provider.js", ["resolveProvider"], {
    ...cache, ...hostingCli, home: () => "/home/me",
    exec: async (tool, args) => {
      calls.push([tool, ...args]);
      if (tool.endsWith("gh")) return { code: 127 };
      if (args[0] === "api") return { code: 0, stdout: '{"path_with_namespace":"group/sub/project"}' };
      return { code: 0 };
    },
  });
  assert.deepEqual(await resolveProvider("ssh://git@code.example/group/sub/project.git"),
    { kind: "gitlab", host: "code.example", repo: "group/sub/project" });
  assert.deepEqual(calls.filter((call) => call[1] !== "--version"), [
    ["glab", "auth", "status", "--hostname", "code.example"],
    ["glab", "api", "--hostname", "code.example", "projects/group%2Fsub%2Fproject"],
  ]);
});

test("changes in decorations keep Editor selection state; wrap recreates its immutable config", async () => {
  const { viewerMethods } = await moduleAt("../mods/xmux-files/views/viewer.js", ["viewerMethods"], {
    languageOf: () => "javascript", codeFont: () => "Menlo", codeSize: () => 14,
  });
  let created = 0, replaced = 0, released = 0;
  const state = { syncCodeState: viewerMethods.syncCodeState, wrap: false,
    newCode: () => { created++; return { set_value: () => replaced++, release: () => released++ }; } };
  state.syncCodeState({ path: "test.js" }, "same source");
  state.syncCodeState({ path: "test.js" }, "same source");
  assert.equal(created, 1);
  assert.equal(replaced, 0);
  state.wrap = true;
  state.syncCodeState({ path: "test.js" }, "same source");
  assert.equal(created, 2);
  assert.equal(released, 1);
});

test("a reused preview reads the currently selected file rather than its original props", async () => {
  const reads = [];
  const { viewerMethods } = await moduleAt("../mods/xmux-files/views/viewer.js", ["viewerMethods"], {
    isImage: () => false, isSvg: () => false,
    readTextFile: async (...args) => { reads.push(args); return "new content"; },
    viewable: text => ({ text }),
  });
  const jobs = [];
  const cx = { spawn: fn => jobs.push(fn(cx)), notify() {} };
  const state = { file: { path: "/new.txt", on: "server" }, viewerFile: { path: "/old.txt" },
    readFile: viewerMethods.readFile, syncCodeState() {}, readMarkdownImages() {}, renderMermaid() {} };
  state.readFile(cx);
  await Promise.all(jobs);
  assert.deepEqual(reads, [["/new.txt", { on: "server" }]]);
  assert.equal(state.text, "new content");
});

test("a Files preview supplies Changes' directory before a stale home cache or shell", async () => {
  const f = await contextFixture();
  f.state.panes[0].cwd = "/home";
  f.data.set("xmux.workspace-contexts", { local: { folder: "/home", on: null } });
  f.data.set("xmux-files.viewers", { viewer: { space: "local", tab: "preview",
    file: { path: "/work/project/mods/xmux-sidebar/views/spaces.js", root: "/work/project", on: null } } });
  assert.equal(f.activeWorkspace().folder, "/work/project");
  f.state.panes = f.state.panes.filter(p => p.tab !== "shell");
  assert.equal(f.activeWorkspace().folder, "/work/project");
});

test("preview sources are limited to the active tab, owning space, mod and machine", async () => {
  const f = await contextFixture();
  for (const bad of [
    { space: "other", tab: "preview", file: { root: "/wrong" } },
    { space: "local", tab: "other", file: { root: "/wrong" } },
    { space: "local", tab: "preview", file: { root: "/wrong", on: "server" } },
  ]) {
    f.data.set("xmux-files.viewers", { bad });
    assert.equal(f.activeWorkspace().folder, "/work/project");
  }
  f.data.set("xmux-files.viewers", { valid: { space: "local", tab: "preview", file: { root: "/wrong" } } });
  f.state.panes[1].mod = "another-mod";
  assert.equal(f.activeWorkspace().folder, "/work/project");
});

test("a remote diff preview uses its saved source without leaking another machine's source", async () => {
  const f = await contextFixture();
  f.state.spaces[0].active = false;
  const sp = f.state.spaces[1];
  sp.active = true;
  sp.tabs.push({ id: "diff", active: true });
  f.state.panes.push({ tab: "diff", mod: "xmux-changes" });
  f.data.set("xmux-changes.diff-tabs", { remote: { source: { cwd: "/remote/checkout", on: "server" } } });
  assert.equal(f.activeWorkspace().folder, "/remote/checkout");
  f.data.set("xmux-changes.diff-tabs", { remote: { source: { cwd: "/wrong", on: null } } });
  assert.equal(f.activeWorkspace().folder, "/remote/project");
});

test("a preview without a registry recovers from a stale home cache using its own terminal", async () => {
  const f = await contextFixture();
  f.data.set("xmux.workspace-contexts", { local: { folder: "/home", on: null } });
  assert.equal(f.activeWorkspace().folder, "/work/project");
});

test("legacy generic agent names follow Core titles even while the rendered remote terminal is stale", async () => {
  const record = { address: "mi-ber/t1v", title: "梳理客户端布局适配需求、进展与结论 | gd-ai-fde" };
  const { automaticTabTitle } = await moduleAt("../lib/xmux/tab-title.js", ["automaticTabTitle"], {
    terminals: () => [record],
  });
  const pane = { terminal: record.address, title: "Codex", app: "codex",
    program: { name: "Codex", key: "codex", agent: true } };
  const tab = { name: "Codex", named: true };
  assert.equal(automaticTabTitle(tab, pane), "梳理客户端布局适配需求、进展与结论");
  assert.equal(automaticTabTitle({ ...tab, name: "我的任务" }, pane), "我的任务");
  assert.equal(automaticTabTitle({ name: "2", named: false }, pane), "梳理客户端布局适配需求、进展与结论");
  assert.equal(automaticTabTitle(tab, { ...pane, terminal: "another/t1v", title: "另一个任务 | repo" }), "另一个任务");
  assert.equal(automaticTabTitle({ name: "README.md", named: true }, { mod: "xmux-files" }), "README.md");
});

test("shell titles and active/focused pane selection retain their behavior", async () => {
  const { automaticTabTitle, tabLead } = await moduleAt("../lib/xmux/tab-title.js", ["automaticTabTitle", "tabLead"], {
    home: () => "/home/me", terminals: () => [],
  });
  const a = { tab: "tab", pane: "a", cwd: "/home/me/project", program: { name: "zsh", shell: true } };
  const b = { tab: "tab", pane: "b", focused: true, program: { agent: true } };
  assert.equal(automaticTabTitle({ name: "1" }, a), "zsh ~/project");
  assert.equal(tabLead({ id: "tab", active: true }, [a, b], a), a);
  assert.equal(tabLead({ id: "tab", active: false }, [a, b], a), b);
});

test("Pi tabs and floating terminals follow Core titles even when a session label is present", async () => {
  const agentProgram = { name: "Pi", key: "pi", agent: true };
  const shellProgram = { name: "zsh", key: "shell", shell: true, agent: false };
  const pane = { terminal: "mi-ber/t1", title: "π - project", app: "pi", program: agentProgram };
  const record = {
    address: pane.terminal, title: pane.title, program: agentProgram,
    labels: { "heeler.session": JSON.stringify({ file: "/sessions/old.jsonl" }) },
    foreground: { cwd: "/home/me/project" },
  };
  const { automaticTabTitle, floatingTerminalTitle } = await moduleAt(
    "../lib/xmux/tab-title.js", ["automaticTabTitle", "floatingTerminalTitle"],
    { home: () => "/home/me", terminals: () => [record] },
  );
  const tab = { name: "2" };
  assert.equal(automaticTabTitle(tab, pane), "π - project");
  assert.equal(floatingTerminalTitle(record), "π - project");

  record.title = "π - Fix login flow - project";
  assert.equal(automaticTabTitle(tab, pane), record.title);
  assert.equal(automaticTabTitle({ name: "Pi", named: true }, pane), record.title);
  assert.equal(automaticTabTitle({ name: "My tab", named: true }, pane), "My tab");
  assert.equal(floatingTerminalTitle(record), record.title);

  Object.assign(record, { title: "me@host: ~/project", program: shellProgram });
  assert.equal(automaticTabTitle(tab, { ...pane, program: shellProgram }), "me@host: ~/project");
  assert.equal(automaticTabTitle(tab, pane), "me@host: ~/project");
  assert.equal(floatingTerminalTitle(record), "me@host: ~/project");

  delete record.title;
  assert.equal(automaticTabTitle(tab, pane), "zsh ~/project");
  assert.equal(automaticTabTitle({ name: "My tab", named: true }, pane), "My tab");
});

test("SSH login, directory changes, and exit update both titles from Core", async () => {
  const shell = { name: "zsh", key: "shell", shell: true };
  const ssh = { name: "ssh", key: "program" };
  const local = "xiaomi@Mi-M2: ~/works/herdr-xmux";
  const pane = { terminal: "t1", title: local, program: shell };
  const terminal = { address: "t1", cwd: "/Users/xiaomi/works/herdr-xmux" };
  const tab = { name: "1" };
  const { automaticTabTitle, floatingTerminalTitle } = await moduleAt(
    "../lib/xmux/tab-title.js", ["automaticTabTitle", "floatingTerminalTitle"],
    { home: () => "/Users/xiaomi", terminals: () => [terminal] },
  );

  for (const [program, title] of [
    [shell, local],
    [ssh, "gd@ai-m4:~"],
    [ssh, "gd@ai-m4:~/work"],
    [shell, local],
  ]) {
    Object.assign(terminal, { program, title });
    pane.program = program;
    assert.equal(floatingTerminalTitle(terminal), title);
    assert.equal(automaticTabTitle(tab, pane), title);
  }
  assert.equal(automaticTabTitle({ named: true, name: "Pinned name" }, pane), "Pinned name");
  assert.equal(automaticTabTitle(tab, { program: ssh, title: "gd@ai-m4:~" }), "gd@ai-m4:~");
  assert.equal(floatingTerminalTitle({ program: shell, foreground: { cwd: terminal.cwd } }), "zsh ~/works/herdr-xmux");
});

async function fileMenuFixture() {
  const overlays = [];
  const api = await moduleAt("../lib/xmux/file-menu.js", ["fileMenuTarget", "showFileMenu"], {
    spaces: () => [{ id: "owner", active: true }], openOverlay: o => overlays.push(o),
  });
  return { ...api, overlays };
}

test("all file menus carry absolute path, relative path, workspace, machine and owning space", async () => {
  const f = await fileMenuFixture();
  const target = f.fileMenuTarget({ path: "/repo/src/a b.js", root: "/repo", on: "server" }, { space: "remote", changed: true });
  assert.deepEqual(target, { path: "/repo/src/a b.js", root: "/repo", on: "server", space: "remote",
    top: "/repo", dir: false, relative: "src/a b.js", changed: true, staged: false });
  f.showFileMenu(target);
  assert.equal(f.overlays[0].mod, "xmux-files");
  assert.equal(f.overlays[0].props.target, target);
  assert.equal(f.fileMenuTarget({ path: "/a.js", root: "/" }).relative, "a.js");
});

test("Files menu replaces Open in new tab with one shared VS Code action", async () => {
  const f = await fileMenuFixture(), calls = [];
  const { contextMenuMethods } = await moduleAt("../mods/xmux-files/views/context-menu.js", ["contextMenuMethods"], {
    foundEditors: () => [{ bundle: "com.microsoft.VSCode", name: "VS Code" }, { bundle: "other", name: "Other Editor" }],
    shared: () => false, chatItems: () => [{ label: "Add to chat" }, { label: "Add to other chat" }],
  });
  const state = { menuSpace: "owner", spaceAgents: () => [], newAgentChoices: () => [],
    openInVsCode: file => calls.push(file) };
  for (const on of [null, "server"]) {
    const target = f.fileMenuTarget({ path: "/repo/a.js", root: "/repo", on });
    const groups = contextMenuMethods.menuItems.call(state, target);
    const items = groups.flat();
    assert.equal(items.some(i => i.label === "Open in new tab"), false);
    const vscode = items.filter(i => i.label === "Open in VS Code");
    assert.equal(vscode.length, 1);
    vscode[0].run();
    assert.deepEqual(calls.at(-1), { path: target.path, root: target.root, on, space: "owner" });
    assert.equal(items.some(i => i.label === "Open in Other Editor"), !on);
    assert.equal(groups[0].some(i => i.label === "Open in VS Code"), true);
    if (!on) assert.deepEqual(groups[1].map(i => i.label), ["Show in Finder"]);
    assert.deepEqual(groups.at(-1).map(i => i.label), ["Add to chat", "Add to other chat"]);
  }
});

test("Changes and Commits file rows open the menu without picking or staging", async () => {
  const f = await fileMenuFixture(), menus = [], rows = [];
  const node = () => new Proxy({}, { get: (_t, k) => (...args) => {
    if (k === "on_mouse_down") rows.at(-1).right = args[1];
    return node();
  } });
  const { sidebarMethods } = await moduleAt("../mods/xmux-changes/views/sidebar.js", ["sidebarMethods"], {
    theme: () => ({}), shared: () => null, TEXT: {},
    Row: config => { rows.push({ config }); return node(); },
    FileIcon: () => null, div: node, h_flex: node, DiffStat: () => null, StatusLetter: () => null,
    IconButton: () => null, fileMenuTarget: f.fileMenuTarget, showFileMenu: t => menus.push(t),
  });
  let stopped = 0, picked = 0, staged = 0;
  const state = { root: "/repo", on: "server", view: "flat", diffSpace: "remote", pick: () => picked++, indexAction: () => staged++ };
  for (const scope of ["unstaged", "staged", "commit", "committed"]) {
    sidebarMethods.fileRow.call(state, { path: "src/a.js" }, scope, 0);
    rows.at(-1).right({}, { stop_propagation: () => stopped++ });
    assert.equal(menus.at(-1).space, "remote");
    assert.equal(menus.at(-1).on, "server");
    assert.equal(menus.at(-1).relative, "src/a.js");
    assert.equal(menus.at(-1).changed, ["staged", "unstaged"].includes(scope));
  }
  assert.equal(stopped, 4);
  assert.equal(picked, 0);
  assert.equal(staged, 0);
});

test("VS Code opening keeps workspace and path separate, including remote SSH; failure is handled", async () => {
  const calls = [], errors = [];
  const { outsideMethods } = await moduleAt("../mods/xmux-files/actions/outside.js", ["outsideMethods"], {
    shared: () => ({ "com.microsoft.VSCode": "/Custom Apps/VS Code.app" }),
    exec: async (...args) => { calls.push(args); return { code: 0 }; },
    setShared: (...args) => errors.push(args),
  });
  const state = { ...outsideMethods, remoteVsCodeTarget: async () => "my host" };
  const file = { root: "/repo with spaces", path: "/repo with spaces/a b.js" };
  await state.openInVsCode(file);
  assert.deepEqual(calls.at(-1), ["/Custom Apps/VS Code.app/Contents/Resources/app/bin/code",
    ["--reuse-window", file.root, file.path], {}]);
  await state.openInVsCode({ ...file, on: "server" });
  assert.deepEqual(calls.at(-1)[1], ["--remote", "ssh-remote+my host", file.root, file.path]);
  state.remoteVsCodeTarget = async () => { throw new Error("No SSH target"); };
  await assert.doesNotReject(state.openInVsCode({ ...file, on: "server" }));
  assert.match(errors.at(-1)[1], /No SSH target/);
});

test("a preview restored on another client rebases machine, space and tab IDs to its owning space", async () => {
  const { restoreViewerSource } = await moduleAt("../mods/xmux-files/actions/open.js", ["restoreViewerSource"]);
  const entry = { space: "m5/space-id", tab: "m5/tab-id", file: { root: "/repo", path: "/repo/a.js", on: "m5" } };
  const local = restoreViewerSource(entry, [{ id: "space-id", machine: null, tabs: [{ id: "tab-id" }] }]);
  assert.deepEqual(local, { space: "space-id", tab: "tab-id", file: { root: "/repo", path: "/repo/a.js", on: null } });
  const remote = restoreViewerSource(local, [{ id: "server/space-id", machine: "server", tabs: [{ id: "server/tab-id" }] }]);
  assert.equal(remote.file.on, "server");
  assert.equal(remote.space, "server/space-id");
  assert.equal(remote.tab, "server/tab-id");
  assert.equal(restoreViewerSource(entry, [{ id: "other", machine: "wrong" }]), entry);
});

test("rapid Files clicks bind same-named previews to distinct tabs and reselect by path", async () => {
  const data = new Map();
  const requests = [];
  const space = { id: "space", active: true, tabs: [] };
  const panes = [];
  const { openMethods, viewerEntries } = await moduleAt("../mods/xmux-files/actions/open.js", ["openMethods", "viewerEntries"], {
    baseName: (path) => path.split("/").pop(),
    spaces: () => [space], panes: () => panes,
    shared: (key) => data.get(key), setShared: (key, value) => data.set(key, value),
    run: (name, args) => requests.push([name, args]),
  });
  const first = { path: "/repo/a/main.js" };
  const second = { path: "/repo/b/main.js" };
  openMethods.openFile(first);
  openMethods.openFile(second);
  openMethods.openFile(first);
  assert.deepEqual(requests.map(([name]) => name), ["tab.new", "tab.new"]);

  // Herdr can publish the two new tabs before either viewer has bound its tab.
  for (const [index, [, request]] of requests.entries()) {
    const id = `tab-${index}`;
    space.tabs.push({ id, name: request.name });
    panes.push({ tab: id, mod: "xmux-files" });
  }
  for (const [id, entry] of Object.entries(viewerEntries()).reverse())
    openMethods.bindViewerTab(id, entry);
  for (const tab of space.tabs) tab.name = "main.js";
  requests.length = 0;
  openMethods.openFile(first);
  openMethods.openFile(second);
  assert.deepEqual(requests, [["tab.select", { id: "tab-0" }], ["tab.select", { id: "tab-1" }]]);
});

test("the popup stays alive until an asynchronous editor launch completes", async () => {
  const handlers = [], closed = [], gate = deferred();
  const node = () => new Proxy({}, { get: (_t, k) => (...args) => {
    if (k === "on_click") handlers.push(args[0]);
    if (k === "when" && args[0]) args[1](node());
    return node();
  } });
  const { contextMenuMethods } = await moduleAt("../mods/xmux-files/views/context-menu.js", ["contextMenuMethods"], {
    theme: () => ({}), props: () => ({ overlay: "popup" }), TEXT: {}, div: node, v_flex: node,
    closeOverlay: id => closed.push(id), setShared() {},
  });
  const state = { menuItems: () => [[{ id: "vscode", label: "Open in VS Code", run: () => gate.promise }]] };
  contextMenuMethods.menuView.call(state);
  const running = handlers[0]({}, {});
  assert.deepEqual(closed, []);
  gate.resolve();
  await running;
  assert.deepEqual(closed, ["popup"]);
});

test("chat references follow the receiving pane, space and machine", async () => {
  const agent = { address: "remote/t1", pane: "pane", space: "remote/one" };
  const state = { focus: { pane: "pane", terminal: agent.address } };
  const terminal = { address: agent.address, state: "live" };
  const overlays = [], commands = [], calls = [], sleeps = [];
  const { chatItems, chatText } = await moduleAt("../lib/xmux/chat-menu.js", ["chatItems", "chatText"], {
    focused: () => state.focus, agents: () => [agent], terminals: () => [terminal],
    panes: () => [{ pane: agent.pane, cwd: "/project/src" }],
    spaces: () => [{ id: agent.space, machine: "remote" }], openOverlay: o => overlays.push(o),
    run: command => commands.push(command),
    exec: async (...args) => { calls.push(args); return { code: 0, stdout: "Mi-Local\n" }; },
  });
  const target = { space: "remote/one", on: "remote", root: "/project", path: "/project/docs/file name.md" };
  assert.equal(chatText(target, agent), " ../docs/file name.md ");
  assert.equal(chatText({ ...target, space: "remote/two" }, agent), " /project/docs/file name.md ");
  assert.equal(chatText({ ...target, on: "mi-ber" }, agent), " mi-ber:/project/docs/file name.md ");
  assert.equal(chatText({ url: "https://example.org/issue" }, agent), " https://example.org/issue ");
  chatItems(target)[1].run();
  assert.deepEqual(overlays[0].props, { mode: "chat-picker", target });
  assert.ok(overlays[0].width > overlays[0].height);
  state.focus = { pane: "shell", terminal: "t0" };
  assert.equal(chatItems(target)[0].disabled, true);
  state.focus = { pane: agent.pane, terminal: agent.address };
  let clipboard = "previous";
  const cx = {
    read_from_clipboard: () => clipboard,
    write_to_clipboard: text => { clipboard = text; },
    spawn: task => task(cx),
    sleep: () => new Promise(resolve => sleeps.push(resolve)),
  };
  const pending = chatItems(target)[0].run(cx);
  assert.deepEqual(commands, ["terminal.paste"]);
  assert.equal(clipboard, " ../docs/file name.md ");
  sleeps.shift()();
  await pending;
  assert.equal(clipboard, "previous");

  const localToRemote = chatItems({ ...target, on: null })[0].run(cx);
  await Promise.resolve();
  assert.deepEqual(calls, [["hostname", [], { on: null, timeout: 2000 }]]);
  assert.equal(clipboard, " Mi-Local:/project/docs/file name.md ");
  sleeps.shift()();
  await localToRemote;
  assert.equal(clipboard, "previous");
});

test("chat picker defaults to the current space and navigates both columns with the keyboard", async () => {
  const chats = [
    { address: "remote/t1", space: "remote/earlier" },
    { address: "remote/t2", space: "remote/current" },
    { address: "remote/t3", space: "remote/current" },
  ];
  const spaces = [
    { id: "remote/earlier", machine: "remote" },
    { id: "remote/current", machine: "remote", active: true },
  ];
  const closed = [], accepted = [];
  const { chatPickerMethods } = await moduleAt("../mods/xmux-files/views/chat-picker.js", ["chatPickerMethods"], {
    agents: () => chats, machines: () => [{ name: "remote" }], spaces: () => spaces,
    closeOverlay: id => closed.push(id), ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
  });
  const picker = { ...chatPickerMethods, addToPickedChat: agent => accepted.push(agent.address) };
  const cx = { focus_handle: () => ({ focus() {} }), stop_propagation() {}, notify() {} };
  picker.initChatPicker({}, cx);
  assert.equal(picker.chatAgent, "remote/t2");
  assert.equal(picker.chatColumn, "agent");
  const key = (name, selected = chats[1]) => picker.chatPickerKey({ key: name }, cx, [null, "remote"], chats, selected, "dialog");
  key("down");
  assert.equal(picker.chatAgent, "remote/t3");
  key("enter", chats[2]);
  assert.deepEqual(accepted, ["remote/t3"]);
  key("left");
  assert.equal(picker.chatColumn, "machine");
  key("up");
  assert.equal(picker.chatMachine, null);
  key("enter");
  assert.equal(picker.chatColumn, "agent");
  key("escape");
  assert.deepEqual(closed, ["dialog"]);
});

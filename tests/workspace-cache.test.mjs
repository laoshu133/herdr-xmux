import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function moduleAt(path, names, deps = {}, clock = Date) {
  const source = (await readFile(new URL(path, import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "");
  return new Function("deps", "Date", `const { ${Object.keys(deps).join(",")} } = deps;\n${source}\nreturn {${names.join(",")}};`)(deps, clock);
}

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

test("recognized hosts require no provider API probe; custom hosts share their probe", async () => {
  const cache = await cacheFixture();
  const calls = [];
  const f = await moduleAt("../lib/xmux/provider.js", ["resolveProvider"], { ...cache,
    exec: async (tool, args, options) => { calls.push({ tool, args, options });
      return { code: 0, stdout: '{"nameWithOwner":"a/b"}' }; },
  });
  assert.equal((await f.resolveProvider("git@gitlab.com:a/b.git")).kind, "gitlab");
  assert.equal(calls.length, 0);
  await Promise.all([f.resolveProvider("git@code.example:a/b.git"), f.resolveProvider("git@code.example:a/b.git")]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.on, null);
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
    shared: () => false,
  });
  const state = { menuSpace: "owner", spaceAgents: () => [], newAgentChoices: () => [],
    openInVsCode: file => calls.push(file) };
  for (const on of [null, "server"]) {
    const target = f.fileMenuTarget({ path: "/repo/a.js", root: "/repo", on });
    const items = contextMenuMethods.menuItems.call(state, target).flat();
    assert.equal(items.some(i => i.label === "Open in new tab"), false);
    const vscode = items.filter(i => i.label === "Open in VS Code");
    assert.equal(vscode.length, 1);
    vscode[0].run();
    assert.deepEqual(calls.at(-1), { path: target.path, root: target.root, on, space: "owner" });
    assert.equal(items.some(i => i.label === "Open in Other Editor"), !on);
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

test("the popup stays alive until an asynchronous editor launch completes", async () => {
  const handlers = [], closed = [], gate = deferred();
  const node = () => new Proxy({}, { get: (_t, k) => (...args) => {
    if (k === "on_click") handlers.push(args[0]);
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

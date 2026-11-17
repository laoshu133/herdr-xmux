import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Exercise lifecycle and command routing at the Herdr boundary. Rendering and
// keyboard focus still require the actual app; these mocks never start hc.
const source = await readFile(new URL("../mods/xmux-status/quick-dialog.js", import.meta.url), "utf8");
const imports = source.match(/^import \{ (.+) \} from "herdr";/)[1];
const load = new Function("api", source.replace(/^import .+;\n/, `const { ${imports} } = api;\n`).replace("export class", "class") + "\nreturn QuickDialog;");
const STATE = "xmux.quick-dialog";
const owner = "/config/app";

function fixture() {
  const values = new Map();
  const calls = [];
  const live = [];
  let focus = { terminal: "t1", pane: "p1", cwd: "/work" };
  let reply;
  let focusReply = () => ({ code: 0, stdout: "{}", stderr: "" });
  const api = {
    appHome: () => owner,
    checking: () => false,
    home: () => "/home/local",
    focused: () => focus,
    panes: () => [{ pane: "p1", terminal: "t1" }],
    terminals: () => live,
    shared: key => values.get(key),
    setShared: (key, value) => values.set(key, value),
    closeOverlay: id => calls.push(["hide", id]),
    openOverlay: spec => { calls.push(["show", spec]); return "overlay"; },
    run: (name, args) => calls.push([name, args]),
    notify: value => calls.push(["error", value]),
    exec: async (...args) => { calls.push(["exec", ...args]); return focusReply(...args); },
    hc: async args => {
      calls.push(["hc", args]);
      if (reply) return reply(args);
      if (args[0] === "get") return { code: 0, stdout: JSON.stringify(live.find(t => t.address === args[1])) };
      const terminal = { address: "t2", state: "live", labels: { "xmux.quick-dialog": owner } };
      live.push(terminal);
      return { code: 0, stdout: JSON.stringify(terminal) };
    },
  };
  const controller = new (load(api))();
  controller.init();
  return { controller, calls, live, state: () => values.get(STATE), setState: value => values.set(STATE, value), focus: value => { focus = value; }, reply: value => { reply = value; }, focusReply: value => { focusReply = value; } };
}

test("hide and reopen reuse the shell and restore the source pane", async () => {
  const f = fixture();
  await f.controller.toggle();
  const launch = f.calls.find(c => c[0] === "hc")[1];
  assert.equal(launch[launch.indexOf("--cwd") + 1], "/work");
  assert.ok(launch.includes("--no-parent"));
  assert.ok(launch.includes("--rm"));
  assert.ok(!launch.includes("--keep"));
  assert.ok(!launch.includes("--on"));
  f.focus({ terminal: "t2", pane: null });
  await f.controller.toggle();
  assert.equal(f.state().overlay, null);
  assert.equal(f.live[0].state, "live");
  assert.deepEqual(f.calls.at(-1), ["pane.focus", { pane: "p1" }]);
  await f.controller.toggle();
  assert.equal(f.state().terminal, "t2");
  assert.equal(f.calls.filter(c => c[0] === "hc" && c[1][0] === "run").length, 1);
  assert.equal(f.calls.filter(c => c[0] === "terminal.kill").length, 0);
});

test("opening and reopening quietly request focus after mounting the window", async () => {
  const f = fixture();
  const request = ["exec", "env", [`HERDR_APP_HOME=${owner}`, "herdr-app", "do", "pane.focus", '{"terminal":"t2"}'], { on: null, timeout: 2000 }];
  await f.controller.toggle();
  assert.equal(f.calls.at(-2)[0], "show");
  assert.equal(f.calls.at(-2)[1].kind, "window");
  assert.deepEqual(f.calls.at(-1), request);
  f.focus({ terminal: "t2", pane: null });
  await f.controller.toggle();
  await f.controller.toggle();
  assert.equal(f.calls.at(-2)[0], "show");
  assert.deepEqual(f.calls.at(-1), request);
});

for (const error of ["no such pane", "unknown command: pane.focus"]) {
  test(`unsupported focus (${error}) keeps the window and retries on reopening`, async () => {
    const f = fixture();
    f.focusReply(() => ({ code: 1, stdout: JSON.stringify({ error }), stderr: "" }));
    await f.controller.toggle();
    assert.equal(f.state().overlay, "overlay");
    assert.ok(!f.calls.some(c => c[0] === "error" || c[0] === "pane.focus"));
    await f.controller.toggle();
    f.focusReply(() => ({ code: 0, stdout: "{}", stderr: "" }));
    await f.controller.toggle();
    assert.equal(f.calls.filter(c => c[0] === "exec").length, 2);
    assert.equal(f.calls.filter(c => c[0] === "hc" && c[1][0] === "run").length, 1);
  });
}

for (const error of ["cannot run env: not found", "command timed out"]) {
  test(`focus transport failure (${error}) does not become a launch error`, async () => {
    const f = fixture();
    f.focusReply(() => { throw new Error(error); });
    await f.controller.toggle();
    assert.equal(f.state().overlay, "overlay");
    assert.ok(!f.calls.some(c => c[0] === "error"));
    await f.controller.toggle();
    assert.equal(f.state().overlay, null);
    assert.equal(f.live[0].state, "live");
  });
}

test("hiding stays responsive while optional focus is pending", async () => {
  const f = fixture();
  let release;
  f.focusReply(() => new Promise(resolve => { release = resolve; }));
  const opening = f.controller.toggle();
  // Let terminal creation finish and the optional focus request begin.
  await Promise.resolve();
  assert.equal(typeof release, "function");
  await f.controller.toggle();
  assert.equal(f.state().overlay, null);
  const afterHide = f.calls.length;
  release({ code: 0, stdout: "{}", stderr: "" });
  await opening;
  assert.equal(f.calls.length, afterHide);
  assert.equal(f.state().overlay, null);
});

test("a remote workspace starts a local shell in local home", async () => {
  const f = fixture();
  f.focus({ terminal: "remote/t1", cwd: "/remote/work" });
  await f.controller.toggle();
  const launch = f.calls.find(c => c[0] === "hc")[1];
  assert.equal(launch[launch.indexOf("--cwd") + 1], "/home/local");
  assert.ok(!launch.includes("--on"));
});

test("rapid toggles cannot launch duplicate shells", async () => {
  const f = fixture();
  let release;
  f.reply(() => new Promise(resolve => { release = resolve; }));
  const first = f.controller.toggle();
  await f.controller.toggle();
  release({ code: 0, stdout: '{"address":"t2"}' });
  await first;
  assert.equal(f.calls.filter(c => c[0] === "hc").length, 1);
  assert.equal(f.state().terminal, "t2");
});

test("reconnection failures do not create a replacement shell", async () => {
  const f = fixture();
  f.setState({ terminal: "t2", overlay: null });
  f.reply(() => ({ code: 1, stderr: "core unavailable" }));
  await f.controller.toggle();
  assert.equal(f.calls.filter(c => c[0] === "show").length, 0);
  assert.equal(f.calls.filter(c => c[0] === "hc" && c[1][0] === "run").length, 0);
  assert.equal(f.calls.at(-1)[0], "error");
});

test("closing a focused floating shell leaves the underlying tab alone", async () => {
  const f = fixture();
  await f.controller.toggle();
  f.focus({ terminal: "t2", pane: null });
  f.controller.closeCurrent();
  assert.ok(f.calls.some(c => c[0] === "terminal.kill" && c[1].terminal === "t2"));
  assert.ok(!f.calls.some(c => c[0] === "tab.close"));
  assert.equal(f.state(), null);
});

test("Cmd+W keeps its tab behavior when the background tab has focus", async () => {
  const f = fixture();
  await f.controller.toggle();
  f.controller.closeCurrent();
  assert.ok(f.calls.some(c => c[0] === "tab.close"));
  assert.ok(!f.calls.some(c => c[0] === "terminal.kill"));
});

test("hiding a background window does not undo the user's pane navigation", async () => {
  const f = fixture();
  await f.controller.toggle();
  f.focus({ terminal: "t3", pane: "p3" });
  const beforeHide = f.calls.length;
  await f.controller.toggle();
  assert.ok(!f.calls.slice(beforeHide).some(c => c[0] === "pane.focus"));
});

test("an exited shell is discarded before starting a fresh one", async () => {
  const f = fixture();
  f.setState({ terminal: "t9", overlay: null });
  f.reply(args => {
    if (args[0] === "get") return { code: 0, stdout: JSON.stringify({ address: "t9", state: "finished", labels: { "xmux.quick-dialog": owner } }) };
    if (args[0] === "rm") return { code: 0, stdout: "{}" };
    return { code: 0, stdout: '{"address":"t2"}' };
  });
  await f.controller.toggle();
  assert.ok(f.calls.some(c => c[0] === "hc" && c[1][0] === "rm" && c[1][1] === "t9"));
  assert.equal(f.state().terminal, "t2");
});

test("reloading the controller reuses the core shell with a fresh overlay id", async () => {
  const f = fixture();
  await f.controller.toggle();
  f.controller.init();
  assert.equal(f.state().overlay, null);
  await f.controller.toggle();
  assert.equal(f.state().terminal, "t2");
  assert.equal(f.calls.filter(c => c[0] === "hc" && c[1][0] === "run").length, 1);
});

test("Cmd+W after a controller reload still cannot close the underlying tab", async () => {
  const f = fixture();
  await f.controller.toggle();
  f.controller.init();
  f.focus({ terminal: "t2", pane: null });
  f.controller.closeCurrent();
  assert.ok(f.calls.some(c => c[0] === "terminal.kill"));
  assert.ok(!f.calls.some(c => c[0] === "tab.close"));
});

test("a terminal from another app configuration is not adopted", async () => {
  const f = fixture();
  f.live.push({ address: "t3", state: "live", labels: { "xmux.quick-dialog": "/another/app" } });
  f.setState({ terminal: "t3", overlay: null });
  await f.controller.toggle();
  assert.equal(f.state().terminal, "t2");
  assert.ok(!f.calls.some(c => c[0] === "terminal.kill"));
});

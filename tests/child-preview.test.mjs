import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../mods/xmux-sidebar/views/child-preview.js", import.meta.url), "utf8");
const load = new Function("api", `
  const { panes, terminals, spaces, run, closeOverlay } = api;
  ${source.replace(/^import .+;\n/gm, "").replace(/^export /gm, "")}
  return { ChildPreview, placeKeptTabs };
`);

function openTerminal({ terminal = "t3", panes = [], terminals = [], spaces = [] }) {
  const calls = [];
  const { ChildPreview, placeKeptTabs } = load({
    panes: () => panes,
    terminals: () => terminals,
    spaces: () => spaces,
    run: (command, args) => calls.push([command, args]),
    closeOverlay: id => calls.push(["close", id]),
  });
  const preview = new ChildPreview();
  preview.terminal = terminal;
  preview.overlay = "preview";
  preview.openTerminal();
  return { calls, placeKeptTabs };
}

test("Keep follows the nearest ancestor with a pane, even while another Space is active", () => {
  const { calls, placeKeptTabs } = openTerminal({
    panes: [{ terminal: "t1", tab: "tab-parent" }],
    terminals: [{ address: "t3", parent: "t2" }, { address: "t2", parent: "t1" }],
    spaces: [
      { id: "current", active: true, tabs: [] },
      { id: "parent", tabs: [{ id: "tab-parent" }] },
    ],
  });
  assert.deepEqual(calls, [
    ["space.select", { id: "parent" }],
    ["terminal.keep", { terminal: "t3" }],
    ["close", "preview"],
  ]);
  const tabs = [{ id: "tab-parent" }, { id: "unrelated" }, { id: "kept" }];
  const allSpaces = [{ id: "parent", tabs }];
  const tabMoveIndex = (actualTabs, source, target, after) => {
    assert.equal(actualTabs, tabs);
    assert.deepEqual([source, target, after], ["kept", "tab-parent", true]);
    return 2;
  };
  placeKeptTabs(allSpaces, [{ terminal: "someone-else", tab: "unrelated" }], tabMoveIndex);
  assert.equal(calls.length, 3);
  const panes = [{ terminal: "t3", tab: "kept" }];
  placeKeptTabs(allSpaces, panes, tabMoveIndex);
  placeKeptTabs(allSpaces, panes, tabMoveIndex);
  assert.deepEqual(calls.slice(3), [["tab.move", { id: "kept", index: 2 }]]);
});

test("Keep falls back to a Space on the terminal's machine if no ancestor has a pane", () => {
  const { calls } = openTerminal({
    terminal: "m2/t3",
    spaces: [{ id: "current", active: true, tabs: [] }, { id: "m2/space", machine: "m2", tabs: [] }],
  });
  assert.deepEqual(calls, [
    ["space.select", { id: "m2/space" }],
    ["terminal.keep", { terminal: "m2/t3" }],
    ["close", "preview"],
  ]);
});

test("Go to selects the existing pane by ID without keeping a second tab", () => {
  const { calls } = openTerminal({ panes: [{ terminal: "t3", pane: "pane-3" }] });
  assert.deepEqual(calls, [["pane.focus", { pane: "pane-3" }], ["close", "preview"]]);
});

test("preview selection follows its titlebar or terminal and clears on blur or dismissal", async () => {
  const source = await readFile(new URL("../lib/xmux/child-preview.js", import.meta.url), "utf8");
  const updates = [];
  const { rememberChildPreview, updateChildPreviewTitleFocus, focusedChildPreview, forgetChildPreview } =
    new Function("globalThis", "setShared", `
      ${source.replace(/^import .+;\n/gm, "").replace(/^export /gm, "")}
      return { rememberChildPreview, updateChildPreviewTitleFocus, focusedChildPreview, forgetChildPreview };
    `)({}, (_key, value) => updates.push(value));
  const behind = { pane: "p1", terminal: "t1", agent: "t1" };
  const previewTerminal = { ...behind, pane: null, terminal: "t2" };

  rememberChildPreview("preview", "t2");
  assert.equal(focusedChildPreview(behind), null);
  updateChildPreviewTitleFocus("preview", true);
  assert.equal(focusedChildPreview(behind), "t2");
  updateChildPreviewTitleFocus("preview", false);
  assert.equal(focusedChildPreview(previewTerminal), "t2");
  assert.equal(focusedChildPreview(behind), null);

  rememberChildPreview("next", "t3");
  updateChildPreviewTitleFocus("next", true);
  forgetChildPreview("preview");
  assert.equal(focusedChildPreview(behind), "t3");
  forgetChildPreview("next");
  assert.equal(focusedChildPreview(behind), null);
  assert.deepEqual(updates, ["preview", null, "next", null]);
});

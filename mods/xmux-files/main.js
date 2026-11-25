// XMux Files: a read-only file browser. One class plays three roles, each its own copy:
//   the sidebar        the tree
//   a viewer           a file in a centre tab
//   the menu           a popup at the pointer on right-click
// shared("xmux-files.*") connects them. The class is built from:
//   files/reads.js        the folder tree and Git's view of it
//   shared/file-icons.js   Better Icons' pictures, when it's installed
//   actions/open.js       opening tabs, and handing a file to XMux Changes
//   actions/outside.js    code editors, Finder
//   views/chat-picker.js  choosing a chat
//   shared/menu.js        popup menus
//   views/tree.js, viewer.js, context-menu.js   the drawing
// files/model.js says what the data means; views/ui.js holds every look.
import { View } from "gpui-kit";
import { Select } from "./views/ui.js";
import { appHome, exec, hc, nextCommand, props, setShared, shared, spaces, readTextFile, writeTextFile, window } from "herdr";
import { invalidateWorktreeStatus } from "./shared/git-status.js";
import { loadSettings, duration } from "./shared/settings.js";
import { followFileIcons } from "./shared/file-icons.js";
import { readMethods } from "./files/reads.js";
import { openMethods, restoreViewerSource } from "./actions/open.js";
import { outsideMethods } from "./actions/outside.js";
import { chatPickerMethods } from "./views/chat-picker.js";
import { menuMethods } from "./shared/menu.js";
import { treeMethods } from "./views/tree.js";
import { viewerMethods } from "./views/viewer.js";
import { contextMenuMethods } from "./views/context-menu.js";
import { createImages } from "./preview/images.js";
import { createDiagrams } from "./preview/diagrams.js";

const DEFAULT_SETTINGS = { refresh: { tree: "10s", file: "2s" }, editors: [], gutter: true, markdown: "preview" };
const SYNC_MS = 300;

class XmuxFiles extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    this.mode = p.mode ?? "sidebar";
    if (this.mode === "menu") {
      this.menuTarget = p.target;
      return;
    }
    if (this.mode === "chat-picker") return this.initChatPicker(p.target, cx);
    this.menuFocus = cx.focus_handle();
    // XMux Tabs draws this on a file's tab.
    setShared("mod-icons", {
      ...(shared("mod-icons") ?? {}),
      "xmux-files": "mods/xmux-files/icons/file.svg",
    });
    followFileIcons(this, cx);
    if (this.mode === "viewer") return this.initViewer(p, cx);
    this.initSidebar(cx);
  }

  initViewer(p, cx) {
    this.viewerId = p.viewer;
    const saved = this.viewerEntry();
    const source = restoreViewerSource(saved ?? { space: p.space, file: p.file });
    if (JSON.stringify(source) !== JSON.stringify(saved)) this.setViewer(this.viewerId, source);
    this.viewerSpace = source.space;
    this.viewerFile = source.file;
    this.viewerMarkdown = p.markdown;
    this.gutterOn = true;
    this.markdownDefault = DEFAULT_SETTINGS.markdown;
    this.hunks = [];
    this.openHunks = new Set();
    this.imageScale = 1;
    this.imagePan = { x: 0, y: 0 };
    this.imageFit = null;
    this.wrap = shared("xmux-files.wrap") ?? false;
    this.imageLoader = createImages({ exec, hc, appHome: () => appHome() });
    this.diagramLoader = createDiagrams({
      exec,
      readTextFile,
      writeFile: (path, text) => writeTextFile(path, text, null),
      mkdir: (path) => exec("mkdir", ["-p", path], { on: null }),
      unlink: (path) => exec("rm", ["-f", "--", path], { on: null }),
      appHome,
      now: Date.now,
    });
    this.file = source.file;
    this.readFile(cx);
    this.syncViewer(cx);
    this.renderMermaid(cx);
    cx.timer.every(SYNC_MS, (cx) => this.syncViewer(cx));
    cx.spawn(async (cx) => {
      const { settings } = await loadSettings("xmux-files", DEFAULT_SETTINGS);
      this.markdownDefault = settings.markdown === "code" ? "code" : "preview";
      cx.notify();
      // Folding can't change once a view is made, so turning the gutter off starts a new one.
      if (settings.gutter === false) {
        this.gutterOn = false;
        this.hunks = [];
        this.code?.release();
        this.code = null;
        this.text = undefined;
        this.readFile(cx);
      }
      cx.timer.every(Math.max(500, duration(settings.refresh.file, 2000)), (cx) => {
        if (!this.viewerVisible() || window()?.active === false) return;
        this.readFile(cx);
        this.readHunks(cx);
      });
    });
  }

  viewerVisible() {
    const entry = this.viewerEntry();
    return spaces().some((s) => s.active && s.id === (entry?.space ?? this.viewerSpace) &&
      s.tabs?.some((t) => t.active && t.id === entry?.tab));
  }

  initSidebar(cx) {
    this.startedAt = Date.now();
    this.saved = new Map();
    this.entries = new Map();
    this.folders = new Set();
    this.marks = {};
    this.refresh(cx);
    this.findChanges(cx);
    cx.timer.every(SYNC_MS, (cx) => this.follow(cx));
    cx.spawn(async (cx) => {
      const { settings, problems } = await loadSettings("xmux-files", DEFAULT_SETTINGS);
      for (const problem of problems) console.warn(`xmux-files mod.json settings: ${problem}`);
      this.findEditors(cx, Array.isArray(settings.editors) ? settings.editors : []);
      cx.timer.every(Math.max(1000, duration(settings.refresh.tree, 10000)), (cx) => {
        if (window()?.active !== false) this.refresh(cx);
      });
    });
    cx.spawn(async (cx) => {
      for (;;) if ((await nextCommand()) === "refresh") {
        invalidateWorktreeStatus(this.top, this.on);
        this.refresh(cx);
      }
    });
  }

  // Keeps up with the focused pane and tabs closing.
  follow(cx) {
    const active = window()?.active !== false;
    const refocused = active && this.windowActive === false;
    this.windowActive = active;
    const next = active ? this.placeKey() : this.key;
    if (active && (refocused || this.treeDirty || next !== this.key) && this.loading !== next) {
      this.treeDirty = false;
      this.refresh(cx);
    }
    this.pruneViewers();
  }

  render() {
    if (this.mode === "menu") return this.menuView();
    if (this.mode === "chat-picker") return this.chatPickerView();
    if (this.mode === "viewer") return this.viewerView();
    return this.sidebarView();
  }
}

Object.assign(
  XmuxFiles.prototype,
  readMethods,
  openMethods,
  outsideMethods,
  chatPickerMethods,
  menuMethods(Select),
  treeMethods,
  viewerMethods,
  contextMenuMethods,
);

export default XmuxFiles;

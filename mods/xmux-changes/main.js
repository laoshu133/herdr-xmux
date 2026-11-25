// XMux Changes: a Git sidebar, and the diff tab it opens in the centre. One
// class plays both roles; shared("xmux-changes.*") connects the copies.
// The class is built from separate files, so a method used here may live in any of:
//   git/repository.js   following the repository, the index, history, commit and amend
//   views/sidebar.js    the tabs, options menu, file groups and commit views
//   views/diff.js       opening a file in the centre tab, reading it, and drawing it
//   views/pane-header.js  the header row above a pane
// git/reads.js reads from Git, git/model.js parses its output, views/ui.js holds every look.
import { View } from "gpui-kit";
import { TextareaState } from "gpui-base";
import { props, shared, setShared, nextCommand, layout, run, notify, closeOverlay, window } from "herdr";
import { configureQueries, panelShown } from "./shared/query-cache.js";
import { loadSettings, duration } from "./shared/settings.js";
import { followFileIcons } from "./shared/file-icons.js";
import { panelCommands } from "./panel.js";
import { gitMethods } from "./git/repository.js";
import { sidebarMethods } from "./views/sidebar.js";
import { diffMethods } from "./views/diff.js";
import { paneHeaderMethods } from "./views/pane-header.js";

const CONTEXT_POLL_MS = 300;
const STATUS_POLL_MS = 10000;
// Preferences a person may change in the installed mod.json under `settings`.
const DEFAULT_SETTINGS = {
  refresh: { status: "10s" },
  limits: { files: 1000, diff_lines: 1500, line_length: 4000, commits_per_page: 50 },
  default: { view: "tree", diff: "inline" },
  panel: { toggle: false },
};

class XmuxChanges extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    // Herdr hands a pane header its pane. One copy runs per pane, so it reads no Git.
    if (p.pane) {
      this.mode = "pane-header";
      this.hovered = false;
      return;
    }
    if (p.overlay) {
      this.mode = "panel-key";
      this.runPanelKey(p.overlay, cx);
      return;
    }
    configureQueries(cx);
    this.mode = p.mode ?? "sidebar";
    this.diffSpace = p.space;
    this.source = p.source;
    this.settings = DEFAULT_SETTINGS;
    this.restoreDiffSelection(p);
    // XMux Tabs draws this on the diff tab.
    setShared("mod-icons", {
      ...(shared("mod-icons") ?? {}),
      "xmux-changes": "mods/xmux-changes/icons/file.svg",
    });
    followFileIcons(this, cx);

    this.tab = localStorage.getItem("tab") === "commit" ? "commit" : "changes";
    this.view = localStorage.getItem("view") === "flat" ? "flat" : "tree";
    this.diffLayout =
      shared("xmux-changes.diff-layout") ??
      (localStorage.getItem("diff-layout") === "split" ? "split" : "inline");
    if (this.mode === "sidebar") setShared("xmux-changes.diff-layout", this.diffLayout);
    this.menuOpen = false;
    this.menuFocus = cx.focus_handle();
    this.closed = new Set();
    this.collapsed = new Set(JSON.parse(localStorage.getItem("collapsed") ?? "[]"));
    this.files = [];
    this.rows = [];
    this.splitOffset = 0;
    this.diffToken = 0;
    this.resetCommits();
    if (this.mode === "sidebar") this.initCommitBox(cx);

    cx.timer.every(CONTEXT_POLL_MS, (cx) => this.follow(cx));
    this.applySettings(cx);
    cx.spawn(async (cx) => {
      for (;;) this.command(await nextCommand(), cx);
    });
    this.refresh(cx);
  }

  // `mod.open:xmux-changes` from a key. `<mod>.<command>` can't reach a hidden
  // panel, so a copy opens as an overlay for a moment and acts on the layout.
  runPanelKey(overlay, cx) {
    cx.spawn(async () => {
      try {
        const { settings } = await loadSettings("xmux-changes", DEFAULT_SETTINGS);
        const commands = panelCommands(layout(), "xmux-changes", settings.panel.toggle);
        if (commands) for (const [name, args] of commands) run(name, args);
        else notify({ title: "XMux Changes isn't in this layout" });
      } finally {
        closeOverlay(overlay);
      }
    });
  }

  initCommitBox(cx) {
    this.message = "";
    this.messageRevision = 0;
    this.commitMode = "commit";
    this.commitMenuOpen = false;
    this.commitMenuFocus = cx.focus_handle();
    this.amendToken = 0;
    this.amendLoading = false;
    this.amendHead = null;
    this.typing = false;
    // Enter makes a new line here; only the button commits.
    this.input = TextareaState.new({ placeholder: "Commit message", rows: 4 });
    this.input.on("change", (_e, cx) => {
      this.message = this.input.value();
      this.messageRevision++;
      cx.notify();
    });
    this.input.on("focus", (_e, cx) => {
      this.typing = true;
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => {
      this.typing = false;
      cx.notify();
    });
  }

  // Read the installed mod.json once, then start the status poll at its pace.
  // The view and diff defaults apply only where nothing was chosen before.
  applySettings(cx) {
    cx.spawn(async (cx) => {
      const { settings, problems } = await loadSettings("xmux-changes", DEFAULT_SETTINGS);
      for (const problem of problems) console.warn(`xmux-changes mod.json settings: ${problem}`);
      // A limit of zero would empty the panel, so it falls back like a bad value.
      for (const key of Object.keys(settings.limits))
        if (!(settings.limits[key] > 0)) settings.limits[key] = DEFAULT_SETTINGS.limits[key];
      this.settings = settings;
      if (localStorage.getItem("view") === null && ["tree", "flat"].includes(settings.default.view))
        this.view = settings.default.view;
      if (
        this.mode === "sidebar" &&
        localStorage.getItem("diff-layout") === null &&
        ["inline", "split"].includes(settings.default.diff)
      ) {
        this.diffLayout = settings.default.diff;
        setShared("xmux-changes.diff-layout", this.diffLayout);
      }
      // A floor, so a bare number read as milliseconds cannot spin Git.
      cx.timer.every(Math.max(1000, duration(settings.refresh.status, STATUS_POLL_MS)), (cx) => {
        // Local file notifications cover normal edits; the slower poll catches
        // missed notifications and external changes to repository metadata.
        if (!this.on && this.watched && Date.now() - (this.refreshed ?? 0) < 60000) return;
        this.refresh(cx);
      });
      cx.notify();
    });
  }

  // `xmux-changes.<command>`, for keys.
  command(command, cx) {
    if (command === "refresh") this.refreshAll(cx);
    if (command === "changes" || command === "commit") this.setTab(command, cx);
    if (command === "flat" || command === "tree") this.setView(command, cx);
    if (command === "inline" || command === "split") this.setDiffLayout(command, cx);
    if (command.startsWith("open:")) {
      const file = this.files.find((f) => f.path === command.slice(5));
      if (file)
        this.pick(file, file.conflict ? "conflict" : file.unstaged ? "unstaged" : "staged", cx);
    }
  }

  visible() {
    if (this.mode === "sidebar") return panelShown(layout(), "xmux-changes");
    const sp = this.diffSpace;
    const tab = this.diffTab(sp);
    return this.diffVisible(tab, sp);
  }

  follow(cx) {
    const active = window()?.active !== false;
    if (active && this.windowActive === false) this.dirty = true;
    this.windowActive = active;
    if (!active) return;
    const shown = this.visible();
    const returning = shown && !this.wasVisible;
    this.wasVisible = shown;
    if (!shown) return;
    if (this.dirty || (returning && Date.now() - (this.refreshed ?? 0) > 2000)) this.refresh(cx);
    const style = shared("xmux-changes.diff-layout");
    if (style && style !== this.diffLayout) {
      this.diffLayout = style;
      localStorage.setItem("diff-layout", style);
      cx.notify();
    }
    if (this.contextKey() !== this.context) this.refresh(cx);
    if (this.mode === "diff") {
      this.syncSelection(cx);
      if (this.root && this.path && this.shownFull !== this.fullFile()) this.loadDiff(cx);
      this.publishHead();
    }
    const reload = shared("xmux-changes.reload");
    if (
      reload &&
      reload.at !== this.reload &&
      reload.root === this.root &&
      reload.on === (this.on ?? null) &&
      !this.loading &&
      !this.busy
    ) {
      this.reload = reload.at;
      this.refresh(cx, true);
    }
  }
}

Object.assign(XmuxChanges.prototype, gitMethods, sidebarMethods, diffMethods, paneHeaderMethods);

export default XmuxChanges;

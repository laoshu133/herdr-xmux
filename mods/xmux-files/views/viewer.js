// A file in the centre pane, read-only, following the file as it changes on disk. Editing
// belongs in the code editor it can open.
import { div, image } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, focused, layout, panes, readTextFile, setShared, shared, theme } from "herdr";
import {
  baseName,
  buildRows,
  fileLinesOf,
  hunkKey,
  isImage,
  isMarkdown,
  isSvg,
  languageOf,
  markdownBlocks,
  parentOf,
  parseHunks,
  resolvePath,
  tokenize,
  viewable,
} from "../files/model.js";
import { viewerEntries } from "../actions/open.js";
import { foundEditors } from "../actions/outside.js";
import { fileIcon, isLight } from "../files/file-icons.js";
import { TEXT, FileIcon, Markdown, Message, MenuButton, TextButton, codeFont, codeSize } from "./ui.js";

const CHAR_WIDTH = 0.62; // Of the code font's size, to size the sideways scroll.
const LINE_COLUMNS = 6; // The number column and a margin, in the same units.
const rowHeight = () => Math.round(codeSize() * 1.6);
const REMOVED_ROW = 8;

const IMAGE_PAD = 16;
const MIN_ZOOM = 0.1, MAX_ZOOM = 8;

// A picture fits both dimensions at first, but small pictures never start enlarged.
export function fittedScale(image, viewport) {
  if (!image || !viewport) return 1;
  const roomW = Math.max(1, viewport.width - IMAGE_PAD * 2);
  const roomH = Math.max(1, viewport.height - IMAGE_PAD * 2);
  return Math.min(1, roomW / image.width, roomH / image.height);
}

const clamp = (n, low, high) => Math.max(low, Math.min(high, n));

export const viewerMethods = {
  // What this tab shows: the registry, then what it was opened with, after a restart.
  viewerEntry() {
    return viewerEntries()[this.viewerId] ?? null;
  },

  // Runs as the tab opens, which is when the focused tab is its own.
  claimTab() {
    const entry = this.viewerEntry();
    if (entry?.tab) return;
    const tab = focused()?.tab;
    if (!tab || !panes().some((p) => p.tab === tab && p.mod === "xmux-files")) return;
    // A tab reopened behind another one must not take that one's place.
    if (Object.values(viewerEntries()).some((other) => other.tab === tab)) return;
    if (entry?.others?.includes(tab)) return;
    this.setViewer(this.viewerId, {
      tab,
      space: entry?.space ?? this.viewerSpace,
      file: entry?.file ?? this.viewerFile,
    });
  },

  syncViewer(cx) {
    this.claimTab();
    const file = this.viewerEntry()?.file ?? this.viewerFile;
    if (!file) return;
    if (file.path !== this.file?.path) {
      this.file = file;
      this.text = undefined;
      this.problem = null;
      this.code?.release();
      this.code = null;
      this.hunks = [];
      this.openHunks = new Set();
      this.imageScale = 1;
      this.imageFit = null;
      this.imagePan = { x: 0, y: 0 };
      this.readFile(cx);
      this.readHunks(cx);
      cx.notify();
    }
    this.renderMermaid(cx);
    this.publishHead();
  },

  // Asked on every check, not just when the text changes: a commit clears marks without
  // touching the file.
  readHunks(cx) {
    const file = this.file;
    if (!file || !this.gutterOn || this.diffing || isImage(file.path)) return;
    this.diffing = true;
    cx.spawn(async (cx) => {
      const git = (args) =>
        exec("git", ["--no-optional-locks", ...args], { cwd: file.root, on: file.on }).catch(() => null);
      let marks = [];
      const status = await git(["status", "--porcelain=v1", "--", file.path]);
      if (status?.code === 0 && status.stdout.startsWith("??")) {
        marks = [{ line: 0, count: Infinity, kind: "added", oldStart: 0, old: [] }];
      } else if (status?.code === 0 && status.stdout.trim()) {
        const diff = await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", "HEAD", "--", file.path]);
        if (diff?.code === 0) marks = parseHunks(diff.stdout);
      }
      this.diffing = false;
      if (this.file?.path !== file.path) return;
      if (JSON.stringify(marks) !== JSON.stringify(this.hunks)) {
        this.hunks = marks;
        if (this.text !== undefined) this.syncCodeState(file, this.text);
        cx.notify();
      }
    });
  },

  // Only a real change touches the view, so the place you're reading stays put.
  readFile(cx) {
    const file = this.viewerFile ?? this.file;
    if (file && isImage(file.path) && !(isSvg(file.path) && this.markdownView() === "code"))
      return this.readImage(cx);
    if (!file || this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      let shown;
      try {
        shown = viewable(await readTextFile(file.path, { on: file.on }));
      } catch {
        shown = { problem: "This file can't be shown: it's too large, or can't be read." };
      }
      this.reading = false;
      if (this.file?.path !== file.path) return;
      if (isSvg(file.path) && this.markdownView() !== "code") return;
      if (shown.problem) {
        this.problem = shown.problem;
        this.text = undefined;
        this.code?.release();
        this.code = null;
      } else if (shown.text !== this.text) {
        this.problem = null;
        this.text = shown.text;
        this.syncCodeState(file, shown.text);
      }
      this.readMarkdownImages(cx);
      this.renderMermaid(cx);
      cx.notify();
    });
  },

  newCode(file, value) {
    const t = theme();
    return EditorState.new({
      language: languageOf(file.path),
      readonly: true,
      value,
      soft_wrap: this.wrap,
      font_family: codeFont(),
      font_size: codeSize(),
      syntax: {
        keyword: t.ansi5,
        string: t.ansi2,
        comment: t.dim,
        function: t.ansi4,
        type: t.ansi3,
        number: t.ansi1,
        constant: t.ansi6,
      },
    });
  },

  // Retained editor state belongs to reads and events, never to render(). Turning wrap off can
  // release its state because the selectable source view is replaced by the diff row view.
  syncCodeState(file, value) {
    if (this.gutterOn && !this.wrap && this.changesOn && this.hunks?.length) {
      this.code?.release();
      this.code = null;
    } else if (this.code) this.code.set_value(value);
    else this.code = this.newCode(file, value);
  },

  // What the pane's header row says, the same row a diff uses: file, folder, and whether
  // this is the shared tab.
  viewerHead() {
    const file = this.file;
    if (!file) return null;
    const name = baseName(file.path);
    const folder = file.path.slice(file.root.length + 1, -name.length - 1);
    const picture = fileIcon(this.fileIcons, file.path, { light: isLight(theme().background) });
    return {
      title: name,
      detail: folder,
      // color: a full-colour picture, which XMux Changes' pane header draws untinted.
      ...(picture ? { icon: picture, color: true } : { icon: "mods/xmux-files/icons/file.svg" }),
    };
  },

  publishHead() {
    const tab = this.viewerEntry()?.tab;
    const pane = tab && panes().find((p) => p.mod === "xmux-files" && p.tab === tab)?.pane;
    const head = this.viewerHead();
    if (!pane || !head) return;
    const heads = shared("pane-heads") ?? {};
    if (JSON.stringify(heads[pane]) !== JSON.stringify(head))
      setShared("pane-heads", { ...heads, [pane]: head });
  },

  // XMux Changes' pane header shows a published title. With any other header, the file
  // draws its own row, so there's always exactly one.
  headerShowsTitle() {
    const find = (node) =>
      node?.content?.pane?.header?.content?.mod ?? (node?.children ?? []).map(find).find(Boolean);
    return find(layout()) === "xmux-changes";
  },

  // The file as rows, the way XMux Changes draws a diff. Herdr's editor can't mark a line,
  // and marks laid over it slid as it scrolled, but here a line's colour is part of its row.
  linesView() {
    const lines = this.fileLines();
    const language = languageOf(this.file.path);
    const rows = buildRows(lines, this.hunks ?? [], this.openHunks);
    const height = rowHeight();
    const sized = rows.some((row) => row.type === "removed")
      ? rows.map((row) => (row.type === "removed" ? REMOVED_ROW : height))
      : height;
    const listId = `viewer-lines-${this.viewerId}-${this.file.path}`;
    const list = v_virtual_list(
      listId,
      rows.length,
      sized,
      (i) => rows[i].key,
      (range) => rows.slice(range.start, range.end).map((row) => this.fileRow(row, language)),
    )
      // A handler per list, not per row: Herdr's virtual lists allow no handlers in a row.
      .on_item_click((key, cx) => this.toggleChange(rows.find((row) => row.key === key), cx))
      .size_full();
    const widest = lines.reduce((most, line) => Math.max(most, line.length), 0);
    return div()
      .id("viewer-lines")
      .flex_1()
      .min_h(0)
      .min_w(0)
      .relative()
      .font_family(codeFont())
      .text_size(codeSize())
      .child(
        div()
          .id("viewer-x")
          .size_full()
          .overflow_x_scrollbar().mode("scrolling")
          .child(
            div()
              .min_w(Math.max(300, (widest * CHAR_WIDTH + LINE_COLUMNS) * codeSize()))
              .h_full()
              .child(list),
          ),
      )
      .child(Scrollbar.vertical(listId).mode("scrolling").viewport_from_layout().absolute().inset_0());
  },

  // Only a change that replaced something has anything to open.
  toggleChange(row, cx) {
    if (!row?.hunk?.old.length) return;
    const key = hunkKey(row.hunk);
    if (!this.openHunks.delete(key)) this.openHunks.add(key);
    cx.notify();
  },

  // Split once per version of the file: rows are drawn on every scroll.
  fileLines() {
    if (this.linesOf !== this.text) {
      this.linesOf = this.text;
      this.lines = fileLinesOf(this.text ?? "");
    }
    return this.lines;
  },

  fileRow(row, language) {
    const t = theme();
    if (row.type === "removed")
      return h_flex()
        .id(`viewer-${row.key}`)
        .h(REMOVED_ROW)
        .w_full()
        .items_center()
        .cursor_pointer()
        .child(div().h(2).w_full().bg(t.ansi1));
    const old = row.type === "old";
    const open = row.hunk && this.openHunks.has(hunkKey(row.hunk));
    // A line whose old version is showing reads as what replaced it.
    const color = old
      ? t.ansi1
      : row.hunk
        ? { added: t.ansi2, changed: open ? t.ansi2 : t.ansi3 }[row.hunk.kind]
        : null;
    const SYNTAX = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, number: t.ansi1 };
    const runs = old ? [{ text: row.text, kind: "old" }] : tokenize(row.text, language);
    return h_flex()
      .id(`viewer-${row.key}`)
      .h(rowHeight())
      .w_full()
      .items_center()
      .when(Boolean(color), (el) => el.bg(`${color?.slice(0, 7)}26`))
      .when(Boolean(row.hunk?.old.length), (el) => el.cursor_pointer())
      .child(
        div()
          .id(color && !old ? `viewer-mark-${row.number - 1}` : `viewer-bar-${row.key}`)
          .w(3)
          .h_full()
          .flex_none()
          .when(Boolean(color), (el) => el.bg(color)),
      )
      .child(
        div()
          .w(codeSize() * 3.5)
          .pr(codeSize())
          .flex_none()
          .text_right()
          .text_color(t.dim)
          .child(String(row.number)),
      )
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .whitespace_nowrap()
          .children(
            runs.map((run) =>
              div()
                .flex_none()
                .whitespace_nowrap()
                .text_color(run.kind === "old" ? t.ansi1 : (SYNTAX[run.kind] ?? t.foreground))
                .child(run.text || " "),
            ),
          ),
      );
  },

  // Local and remote images share a bounded cache in Herdr's data directory.
  readImage(cx) {
    const file = this.viewerFile ?? this.file;
    if (isSvg(file.path) && this.markdownView() === "code") {
      this.imageShown = null;
      this.problem = null;
      return;
    }
    if (this.readingImage || this.imageDrag) return;
    const previousPath = this.imageFor;
    this.imageFor = file.path;
    if (previousPath !== file.path) {
      this.imageShown = null;
      this.imageFit = null;
      this.imagePan = { x: 0, y: 0 };
    }
    this.readingImage = true;
    if (!this.imageShown) this.imageDoc = { phase: "loading" };
    cx.spawn(async (cx) => {
      const result = await this.imageLoader.load(file).catch((error) => ({ error: error.message }));
      this.readingImage = false;
      if (this.file?.path !== file.path) return;
      if (isSvg(file.path) && this.markdownView() === "code") return;
      const changed = result.path !== this.imageShown || result.error !== this.problem;
      if (changed) {
        this.problem = result.error ?? null;
        this.imageShown = result.path ?? null;
        this.imageDoc = result.error ? null : result;
        if (!result.path) this.imageFit = null;
        cx.notify();
      }
    });
  },

  imageView() {
    if (this.problem) return Message(this.problem);
    if (!this.imageShown) return Message(this.imageDoc?.error ?? this.imageDoc?.phase ?? "Loading…");
    const imageDoc = this.imageDoc;
    const viewport = this.imageViewport;
    const fit = fittedScale(imageDoc, viewport);
    if (this.imageFit !== fit) {
      this.imageFit = fit;
      this.imageScale = fit;
      this.imagePan = { x: 0, y: 0 };
    }
    const w = Math.round(imageDoc.width * this.imageScale);
    const h = Math.round(imageDoc.height * this.imageScale);
    const pan = this.imagePan ?? { x: 0, y: 0 };
    const picture = v_flex()
      .id("viewer-image-canvas")
      .size_full()
      .relative()
      .overflow_hidden()
      .cursor_grab()
      .on_scroll_wheel((event, cx) => {
        const delta = event.delta_lines?.y ?? event.delta.y;
        if (!delta) return;
        this.zoomImage(delta < 0 ? 1 : -1, cx);
      })
      .on_pinch((event, cx) => {
        if (!event.delta || !this.imageShown) return;
        const current = this.imageScale ?? this.imageFit ?? 1;
        this.imageScale = clamp(current * (1 + event.delta), MIN_ZOOM, MAX_ZOOM);
        cx.stop_propagation();
        cx.notify();
      })
      .on_mouse_down("left", (event, cx) => {
        this.imageDrag = { at: event.position, pan: { ...pan } };
        this.imageDragging = true;
        cx.stop_propagation();
        cx.notify();
      })
      .on_mouse_move((event, cx) => {
        if (!this.imageDrag) return;
        const drag = this.imageDrag;
        this.imagePan = {
          x: drag.pan.x + event.position.x - drag.at.x,
          y: drag.pan.y + event.position.y - drag.at.y,
        };
        cx.notify();
      })
      .on_mouse_up("left", (_event, cx) => {
        this.imageDrag = null;
        this.imageDragging = false;
        cx.notify();
      })
      .on_hover((hovered, cx) => {
        if (hovered || !this.imageDrag) return;
        this.imageDrag = null;
        this.imageDragging = false;
        cx.notify();
      })
      .child(
        div()
          .id("viewer-picture")
          .absolute()
          .left(((viewport?.width ?? w) - w) / 2 + pan.x)
          .top(((viewport?.height ?? h) - h) / 2 + pan.y)
          .w(w)
          .h(h)
          .when(this.imageDragging, (el) => el.cursor_grabbing())
          .child(image(this.imageShown).w(w).h(h)),
      );
    return div()
      .id("viewer-image")
      .flex_1()
      .min_h(0)
      .min_w(0)
      .on_size_change((size, cx) => {
        if (this.imageViewport?.width === size.width && this.imageViewport?.height === size.height) return;
        this.imageViewport = size;
        cx.notify();
      })
      .child(picture);
  },

  zoomImage(direction, cx) {
    if (!this.imageShown) return;
    const current = this.imageScale ?? this.imageFit ?? 1;
    this.imageScale = clamp(current * (direction > 0 ? 1.25 : 0.8), MIN_ZOOM, MAX_ZOOM);
    cx.stop_propagation();
    cx.notify();
  },

  // Preview or Code, chosen per tab and kept in the registry, else the setting.
  markdownView() {
    return this.viewerEntry()?.markdown ?? this.viewerMarkdown ?? this.markdownDefault ?? "preview";
  },

  showsPreview() {
    return Boolean(this.file && isMarkdown(this.file.path)) && this.markdownView() === "preview";
  },

  // Split once per version of the file, like the code view's lines.
  previewBlocks() {
    const key = `${this.file.path}\0${this.text}`;
    if (this.blocksOf !== key) {
      this.blocksOf = key;
      this.blocks = markdownBlocks(this.text ?? "", parentOf(this.file.path));
    }
    return this.blocks;
  },

  // Markdown's local and remote pictures use the same content-keyed cache as a standalone image.
  readMarkdownImages(cx) {
    const file = this.file;
    if (!file || !isMarkdown(file.path) || this.text === undefined) return;
    this.markdownShown ??= new Map();
    this.markdownCopying ??= new Set();
    for (const block of this.previewBlocks().filter((block) => block.type === "image")) {
      const { path } = block;
      if (this.markdownCopying.has(path)) continue;
      this.markdownCopying.add(path);
      cx.spawn(async (cx) => {
        const result = await this.imageLoader.load({ path, on: file.on }).catch((error) => ({ error: error.message }));
        this.markdownCopying.delete(path);
        if (this.file?.path !== file.path || this.file?.on !== file.on) return;
        if (JSON.stringify(this.markdownShown.get(path)) !== JSON.stringify(result)) {
          this.markdownShown.set(path, result);
          cx.notify();
        }
      });
    }
  },

  // Mermaid is drawn to SVG locally by the bundled Node helper, then cached under data/.
  renderMermaid(cx) {
    const file = this.file;
    if (!file || !isMarkdown(file.path) || this.text === undefined || this.diagramRunning) return;
    const blocks = this.previewBlocks().filter((block) => block.type === "mermaid");
    const pending = blocks.filter((block) => !block.diagram);
    if (!pending.length) return;
    const parts = pending.map((block) => ({ kind: "mermaid", text: block.text, block }));
    const key = this.blocksOf;
    this.diagramRunning = true;
    cx.spawn(async (cx) => {
      await this.diagramLoader.renderAll(
        parts,
        theme(),
        () => this.file?.path === file.path && this.blocksOf === key,
        () => cx.notify(),
      );
      for (const part of parts) part.block.diagram = part.diagram;
      this.diagramRunning = false;
      cx.notify();
    });
  },

  // A web link opens in the browser, and a link to a file here opens it like a click in
  // the tree. Anchors and other schemes do nothing.
  followLink(url, cx) {
    if (/^https?:\/\//i.test(url)) return cx.open_url(url);
    const file = this.file;
    const path = resolvePath(parentOf(file.path), url);
    if (!path || path === file.path) return;
    const root = path.startsWith(`${file.root}/`) ? file.root : parentOf(path);
    this.openFile({ path, root, on: file.on ?? null }, cx);
  },

  previewImage(block) {
    const name = block.alt || baseName(block.path);
    const result = this.markdownShown?.get(block.path);
    if (result?.error) return Message(`${name}: ${result.error}`);
    if (!result?.path) return Message(`${name}: Loading…`);
    return div().flex_none().child(image(result.path).max_w_full().flex_none());
  },

  previewMermaid(block, i) {
    const diagram = block.diagram;
    if (diagram?.error) return Message(`Mermaid: ${diagram.error}`, true);
    if (!diagram?.path) return Message("Rendering diagram…");
    const room = Math.max(80, (this.previewViewport ?? diagram.width) - 48);
    const width = Math.min(diagram.width, room);
    return div().id(`viewer-mermaid-${this.viewerId}-${i}`).flex_none().child(image(diagram.path).w(width).h(width * diagram.height / diagram.width));
  },

  previewView() {
    const body = v_flex()
      .id("viewer-preview")
      .flex_1()
      .min_h(0)
      .min_w(0)
      .overflow_y_scroll()
      .px(24)
      .py(16)
      .gap(12)
      .on_size_change((size, cx) => {
        const width = Math.floor(size.width);
        if (width === this.previewViewport) return;
        this.previewViewport = width;
        cx.notify();
      })
      .children(
        this.previewBlocks().map((block, i) =>
          block.type === "image"
            ? this.previewImage(block)
            : block.type === "mermaid"
              ? this.previewMermaid(block, i)
            : Markdown(`viewer-md-${this.viewerId}-${i}`, block.text).on_link_click((url, cx) => this.followLink(url, cx)),
        ),
      );
    return v_flex()
      .relative()
      .flex_1()
      .min_h(0)
      .child(body)
      .child(Scrollbar.vertical("viewer-preview").mode("scrolling").absolute().inset_0());
  },

  viewerActions() {
    const t = theme();
    const file = this.file;
    const editors = file?.on
      ? foundEditors().filter((editor) => editor.bundle === "com.microsoft.VSCode")
      : foundEditors();
    const markdown = Boolean(file && isMarkdown(file.path));
    const svg = Boolean(file && isSvg(file.path));
    const previewing = this.showsPreview();
    const coding = (!isImage(file?.path ?? "") && !previewing) || (svg && this.markdownView() === "code");
    const showView = (view) => (cx) => {
      this.viewerMarkdown = view;
      this.setViewer(this.viewerId, { markdown: view });
      if (svg && view === "code") this.imageShown = null;
      this.readFile(cx);
      cx.notify();
    };
    // Only changes that replaced something have old lines to show.
    const changed = this.gutterOn && !previewing && (this.hunks ?? []).length > 0;
    const openable = changed && this.changesOn ? this.hunks.filter((hunk) => hunk.old.length).map(hunkKey) : [];
    const allOpen = openable.length > 0 && openable.every((key) => this.openHunks.has(key));
    return h_flex()
      .id("viewer-actions")
      .gap(6)
      .items_center()
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .when(svg, (el) =>
        el.child(
          h_flex()
            .id("viewer-view")
            .gap(2)
            .child(TextButton({ id: "viewer-view-preview", label: "Preview", active: this.markdownView() !== "code", onClick: showView("preview") }))
            .child(TextButton({ id: "viewer-view-code", label: "Code", active: this.markdownView() === "code", onClick: showView("code") })),
        ),
      )
      .when(isImage(file?.path ?? "") && this.imageShown !== null && this.markdownView() !== "code", (el) => {
        const scale = this.imageScale ?? this.imageFit ?? 1;
        return el.child(
          h_flex().id("viewer-zoom").gap(2).items_center()
            .child(TextButton({ id: "viewer-zoom-out", label: "−", disabled: scale <= MIN_ZOOM, onClick: (cx) => this.zoomImage(-1, cx) }))
            .child(div().min_w(44).text_center().text_color(t.dim).child(`${Math.round(scale * 100)}%`))
            .child(TextButton({ id: "viewer-zoom-in", label: "+", disabled: scale >= MAX_ZOOM, onClick: (cx) => this.zoomImage(1, cx) })),
        );
      })
      .when(markdown, (el) =>
        el.child(
          h_flex()
            .id("viewer-view")
            .gap(2)
            .child(TextButton({ id: "viewer-view-preview", label: "Preview", active: previewing, onClick: showView("preview") }))
            .child(TextButton({ id: "viewer-view-code", label: "Code", active: !previewing, onClick: showView("code") })),
        ),
      )
      .when(openable.length > 0, (el) =>
        el.child(
          TextButton({
            id: "viewer-show-old",
            label: "Expand all",
            active: allOpen,
            onClick: (cx) => {
              this.openHunks = new Set(allOpen ? [] : openable);
              cx.notify();
            },
          }),
        ),
      )
      .when(changed, (el) => el.child(TextButton({
        id: "viewer-changes",
        label: "Changes",
        active: this.changesOn,
        onClick: (cx) => {
          this.changesOn = !this.changesOn;
          if (this.text !== undefined) this.syncCodeState(file, this.text);
          cx.notify();
        },
      })))
      .when(coding, (el) => el.child(TextButton({
        id: "viewer-wrap",
        label: "Wrap",
        active: this.wrap,
        onClick: (cx) => {
          this.wrap = !this.wrap;
          setShared("xmux-files.wrap", this.wrap);
          if (this.text !== undefined) this.syncCodeState(this.file, this.text);
          cx.notify();
        },
      })))
      // Opening elsewhere is the final action in every preview, including remote VS Code.
      .when(editors.length > 0, (el) =>
        el.child(
          this.chooser({
            id: "viewer-open-in",
            accessibilityLabel: "Open in an editor",
            width: 200,
            trigger: MenuButton({ id: "viewer-open-in-trigger", label: "Open in" }),
            choices: editors.map((e) => ({ id: e.bundle, label: e.name })),
            onChoose: (bundle) => {
              if (bundle === "com.microsoft.VSCode")
                this.openInVsCode(file).catch((error) => setShared("xmux-files.error", `Could not open ${file.path} in VS Code: ${error.message}`));
              else this.openInEditor(editors.find((e) => e.bundle === bundle), file.path);
            },
          }),
        ),
      );
  },

  viewerView() {
    const t = theme();
    const head = this.viewerHead();
    const inHeader = this.headerShowsTitle();
    const root = v_flex()
      .id("xmux-files-viewer")
      .relative()
      .size_full()
      .min_w(0)
      .min_h(0)
      .overflow_hidden()
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(TEXT.body);
    if (!inHeader && head)
      root.child(
        h_flex()
          .id("viewer-bar")
          .h(30)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .text_size(TEXT.small)
          .child(
            FileIcon({ icons: this.fileIcons, path: this.file.path, color: t.dim, t }),
          )
          .child(div().flex_none().truncate().max_w(260).font_medium().child(head.title))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(head.detail))
          .child(this.viewerActions()),
      );
    const code = this.file && isSvg(this.file.path) && this.markdownView() === "code";
    if (this.file && isImage(this.file.path) && !code) root.child(this.imageView());
    else if (this.problem) root.child(Message(this.problem));
    else if (this.text === undefined) root.child(Message(head ? "Loading…" : "This tab has no file."));
    else if (this.showsPreview()) root.child(this.previewView());
    else if (this.gutterOn && !this.wrap && this.changesOn && this.hunks?.length) root.child(this.linesView());
    else if (!this.code) root.child(Message(head ? "Loading…" : "This tab has no file."));
    else root.child(v_flex().flex_1().min_h(0).child(Editor.new(this.code).flex_1().min_h(0)));
    // There's no row of its own to sit in, so the actions float over the file's corner.
    // On the file's own colour, nearly opaque, so the text under it fades out without a box.
    if (inHeader)
      root.child(
        div()
          .absolute()
          .top(6)
          .right(18)
          .p(3)
          .rounded(7)
          .bg(`${t.background.slice(0, 7)}E6`)
          .child(this.viewerActions()),
      );
    return root;
  },
};

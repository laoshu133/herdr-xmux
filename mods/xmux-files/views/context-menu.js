// The right-click menu: its own small copy of this mod, in a popup at the pointer.
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { closeOverlay, props, shared, setShared, theme } from "herdr";
import { foundEditors } from "../actions/outside.js";
import { chatItems } from "../shared/chat-menu.js";
import { TEXT } from "./ui.js";

export const contextMenuMethods = {
  menuItems(target) {
    const local = !target.on;
    const editors = local ? foundEditors().filter((e) => e.bundle !== "com.microsoft.VSCode") : [];
    const file = { path: target.path, root: target.dir ? target.path : target.root, on: target.on, space: target.space };
    const groups = [[
      ...(!target.dir ? [
        { id: "open", label: "Open", run: (cx) => this.openFile(file, cx) },
      ] : []),
      { id: "vscode", label: "Open in VS Code", run: () => this.openInVsCode(file) },
      ...editors.map((e) => ({
        id: `editor-${e.bundle}`,
        label: `Open in ${e.name}`,
        run: () => this.openInEditor(e, target.path),
      })),
      ...(local && !target.dir
        ? [{ id: "default", label: "Open in default app", run: () => this.openWithDefault(target.path) }]
        : []),
    ]];
    if (local) groups.push([{ id: "reveal", label: "Show in Finder", run: () => this.revealInFinder(target.path) }]);
    if (!target.dir && target.changed && shared("xmux-files.has-changes"))
      groups.push([{ id: "diff", label: "Show diff", run: (cx) => this.showDiff(target, cx) }]);
    groups.push([
      {
        id: "copy-filename",
        label: "Copy filename",
        run: (cx) => cx.write_to_clipboard(target.path.split("/").pop()),
      },
      {
        id: "copy-relative",
        label: "Copy relative path",
        run: (cx) => cx.write_to_clipboard(target.relative),
      },
      { id: "copy-path", label: "Copy full path", run: (cx) => cx.write_to_clipboard(target.path) },
    ]);
    groups.push(chatItems(target));
    return groups.filter((group) => group.length);
  },

  menuView() {
    const t = theme();
    const target = props()?.target ?? this.menuTarget;
    const view = v_flex()
      .id("files-menu")
      .w_full()
      .max_h(520)
      .overflow_y_scrollbar().mode("scrolling")
      .p(4)
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(TEXT.tab);
    this.menuItems(target).forEach((group, i) => {
      if (i) view.child(div().h(1).my(3).flex_none().bg(t.border));
      for (const item of group)
        view.child(
          div()
            .id(`files-menu-${item.id}`)
            .flex_none()
            .h(24)
            .px(8)
            .flex()
            .items_center()
            .rounded(5)
          .when(item.disabled, (el) => el.text_color(t.dim))
          .when(!item.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(async (_e, cx) => {
              if (this.menuBusy) return;
              this.menuBusy = true;
              const overlay = props()?.overlay;
              // Closing a mod cancels its host calls. Keep this copy alive
              // through the SSH lookup and the subsequent editor launch.
              try { await item.run(cx); }
              catch (error) { setShared("xmux-files.error", String(error.message ?? error)); }
              finally { closeOverlay(overlay); }
          }))
            .child(div().truncate().child(item.label)),
        );
    });
    return view;
  },
};

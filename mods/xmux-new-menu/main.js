import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, panes, knownAgents, run, openOverlay, closeOverlay, props, window, keys, shared, setShared } from "herdr";

// The last agents each machine reported, shown at once while knownAgents() checks again.
const KNOWN = "new-menu.agents";

function shortcut(name) {
  const k = keys().find(b => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

export default class NewMenu extends View {
  init(_props, cx) {
    const machine = spaces().find(s => s.id === props()?.space)?.machine ?? spaces().find(s => s.active)?.machine;
    const where = machine ?? "";
    this.agents = shared(KNOWN)?.[where] ?? [];
    this.selected = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async cx => {
      try {
        this.agents = await knownAgents({ on: machine });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agents });
      }
      catch { this.failed = true; }
      cx.notify();
    });
  }
  row(id, icon, name, action, hint = "", enabled = true, selected = false) {
    const t = theme();
    return h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, el => el.cursor_pointer().hover(s => s.bg(t.selected)))
      .when(enabled && selected, el => el.bg(t.selected))
      .on_click(() => { if (enabled) { closeOverlay(props().overlay); action(); } })
      .child(icon).child(div().flex_1().child(name)).child(div().text_size(11).text_color(t.dim).child(hint));
  }
  choose(item) {
    if (!item?.enabled) return;
    closeOverlay(props().overlay);
    item.action();
  }
  render() {
    const t = theme();
    const space = spaces().find(s => s.id === props()?.space) ?? spaces().find(s => s.active);
    const installed = this.agents.filter(a => a.installed);
    const choices = this.failed ? installed : [...installed, ...this.agents.filter(a => !a.installed).slice(0, 2)];
    const items = [
      { key: "terminal", enabled: true, action: () => run("tab.new", { space: space?.id }) },
      ...installed.map(agent => ({ key: agent.key, enabled: true, action: () => run("tab.new", { name: agent.name, space: space?.id, argv: agent.run }) })),
      { key: "space", enabled: true, action: () => run("space.new") },
      { key: "worktree", enabled: Boolean(space), action: () => openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "new" } }) },
      { key: "worktree-open", enabled: Boolean(space), action: () => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "open" } }) },
    ];
    this.selected = Math.min(this.selected, items.length - 1);
    return v_flex().min_h(0).w_full().h(Math.min(491, 167 + Math.max(1, choices.length + (this.failed ? 1 : 0)) * 31)).bg(t.popover).p(5).text_size(12.8)
      .id("new-menu").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        if (["up", "down"].includes(e.key)) {
          cx.stop_propagation();
          const direction = e.key === "down" ? 1 : -1;
          for (let count = 0; count < items.length; count++) {
            this.selected = (this.selected + direction + items.length) % items.length;
            if (items[this.selected].enabled) break;
          }
          cx.notify();
          return;
        }
        if (e.key === "enter") {
          cx.stop_propagation();
          this.choose(items[this.selected]);
          return;
        }
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (!agent) return;
        this.choose(items.find(item => item.key === agent.key));
      })
      .child(this.row("terminal", svg("icons/shell.svg").size(14), "Terminal", items[0].action, shortcut("tab.new"), true, this.selected === 0))
      .child(div().px(9).pt(8).pb(4).text_size(11).text_color(t.dim).child("Start an agent"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().mode("scrolling")
        .children(choices.map((a, i) => this.row(a.key, a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14), a.name,
          items.find(item => item.key === a.key)?.action, a.installed ? (i < 9 ? String(i + 1) : "") : "not installed", a.installed,
          a.installed && items[this.selected]?.key === a.key)))
        .when(this.failed || this.agents.length === 0, el => el.child(div().px(9).py(6).text_color(t.dim).child(this.failed ? "Could not check installed agents" : "Checking installed agents…"))))
      .child(div().h(1).mx(4).my(5).bg(t.border))
      .child(this.row("space", div().w(14).child("+"), "New space", items.find(item => item.key === "space").action, shortcut("space.new"), true, items[this.selected]?.key === "space"))
      .child(this.row("worktree", svg("mods/workspace-chrome/branch.svg").size(14), "New worktree…", items.find(item => item.key === "worktree").action, "", Boolean(space), items[this.selected]?.key === "worktree"))
      .child(this.row("worktree-open", svg("mods/workspace-chrome/branch.svg").size(14), "Open worktree\u2026", items.find(item => item.key === "worktree-open").action, "", Boolean(space), items[this.selected]?.key === "worktree-open"));
  }
}

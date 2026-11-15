// Adapted from Herdr's shipped agents mod, with grouping by main space and by
// name prefix. Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  agents,
  terminals,
  panes,
  focused,
  spaces,
  run,
  theme,
  shared,
  setShared,
  setAgentOrder,
  window,
  layout,
} from "herdr";
import { findNode } from "./find-node.js";
import { TEXT, Icon, IconButton, GroupHeader, Menu, MenuLabel, MenuOption } from "./ui.js";
import { scrollingScrollbar } from "./scrollbar.js";
import { automaticTabTitle, tabLead } from "./tab-title.js";

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = findNode(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", {
    id: "sidebar",
    px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44,
  });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all = panes()) {
  return tabLead(tab, all, focused());
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling =
    live &&
    live !== prog &&
    !/^[~/]|^[A-Za-z]:\\/.test(live) &&
    !live.includes("@") &&
    live.toLowerCase() !== l?.program?.key;
  return tab.name === prog && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
  { id: "parent", label: "Grouped by main space", icon: "git-branch" },
  { id: "prefix", label: "Grouped by prefix", icon: "tag" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

// Herdr's tab.move index is one-based and describes the insertion point after
// the dragged tab has been removed. Keep this calculation local to the
// sidebar so it can reorder the same-space tabs without coupling mods.
function tabMoveIndex(tabs, sourceID, targetID, after) {
  const from = tabs.findIndex((tab) => tab.id === sourceID);
  const target = tabs.findIndex((tab) => tab.id === targetID);
  if (from < 0 || target < 0) return null;
  const boundary = target + (after ? 1 : 0);
  const destination = boundary - (from < boundary ? 1 : 0);
  return destination === from ? null : destination + 1;
}

// Sidebar rows are compact and the pointer often crosses the next row quickly;
// distance alone is enough to distinguish a drag from a click here.
const TAB_DRAG_DELAY_MS = 0;
const TAB_DRAG_DISTANCE = 8;

// PR-12, INS-4 and PLAT-work, also after a folder such as feature/INS-4: capitals
// need nothing more, while lower case needs a number so herdr-mods is no prefix.
const PREFIX = /(?:^|\/)(?:([A-Z][A-Z0-9]*)-\S|([A-Za-z][A-Za-z0-9]*)-\d)/;
export function namePrefix(...names) {
  for (const name of names) {
    const match = PREFIX.exec(name ?? "");
    if (match) return (match[1] ?? match[2]).toUpperCase();
  }
  return null;
}

// How `sort` gathers agents: a group's key and heading. Null keeps priority's sections.
function grouping(sort, tabName) {
  if (sort === "grouped") return (a) => ({ id: `sp-${a.space}`, label: a.space_name || "" });
  if (sort === "parent") {
    const parents = shared("xmux-better-sidebar.space-parents") ?? {};
    return (a) => {
      const parent = parents[a.space];
      return parent
        ? { id: `repo-${parent.key}`, label: parent.label }
        : { id: `sp-${a.space}`, label: a.space_name || "" };
    };
  }
  if (sort === "prefix")
    return (a) => {
      const prefix = namePrefix(a.space_name, tabName(a));
      return prefix
        ? { id: `prefix-${prefix}`, label: `${prefix}-` }
        : { id: "prefix-none", label: "No prefix" };
    };
  return null;
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint
    ? svg(p.icon).size(size).flex_none().text_color(color)
    : image(p.icon).w(size).h(size).flex_none();
}

// What a row calls an agent: its tab's title, or failing that its own.
function agentLabel() {
  const tabs = spaces().flatMap((s) => s.tabs);
  return (a) => {
    const tab = tabs.find((candidate) => candidate.id === a.tab);
    return tab ? title(tab, lead(tab)) : a.title || a.program?.name || "";
  };
}

// Same group next to each other, so the list reads, and next-agent keys move, in order.
function gatherGroups(list, groupOf, sortId) {
  const gathered = new Map();
  for (const a of list) {
    const { id } = groupOf(a);
    gathered.set(id, [...(gathered.get(id) ?? []), a]);
  }
  const ids = [...gathered.keys()];
  if (sortId === "prefix")
    ids.sort((x, y) => (x === "prefix-none") - (y === "prefix-none") || x.localeCompare(y));
  return ids.flatMap((id) => gathered.get(id));
}

export class Agents {
  init(_props, cx) {
    this.sortOpen = false;
    this.sortFocus = cx.focus_handle();
    this.folded = new Set();
    this.tabDrag = null;
    this.tabRows = new Map();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed))
      if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  setPins(pins) {
    this.pins = pins;
    localStorage.setItem("pins", JSON.stringify(pins));
  }

  // Drops pins of agents that ended. Only for machines the list has heard from:
  // right after a start, or while a machine connects, its agents aren't listed yet.
  prunePins(all) {
    const machine = (addr) => (addr.includes("/") ? addr.split("/")[0] : "");
    const heard = new Set(all.map((k) => machine(k.address)));
    const live = new Set(all.filter((k) => k.state === "live").map((k) => k.address));
    const kept = this.pins.filter((p) => !heard.has(machine(p)) || live.has(p));
    if (kept.length !== this.pins.length) this.setPins(kept);
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle")
      this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone =
      a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : (RANK[a.status] ?? 0);
  }

  // Sort menu for the lists view's tab bar.
  sortMenu() {
    return this.renderSortMenu(sortOf());
  }

  sortOptions() {
    const on = sortOf().id;
    return SORTS.map((s) =>
      MenuOption({
        id: `sort-${s.id}`,
        icon: s.icon,
        label: s.label,
        selected: s.id === on,
        onClick: (cx) => {
          setShared("agents.sort", s.id);
          this.sortOpen = false;
          cx.notify();
        },
      }),
    );
  }

  renderSortMenu(sort) {
    return Menu({
      id: "ag-sort-menu",
      open: this.sortOpen,
      focus: this.sortFocus,
      onOpenChange: (open, cx) => {
        this.sortOpen = open;
        cx.notify();
      },
      trigger: IconButton({
        id: "ag-sort",
        icon: sort.icon,
        label: `Sort agents: ${sort.label}`,
        iconSize: 14,
        muted: true,
      }),
      children: [MenuLabel("Sort agents"), ...this.sortOptions()],
    });
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .cursor_pointer()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(
        s.lines.map((l) =>
          div()
            .self_start()
            .mt(-4)
            .w(9)
            .h(17)
            .mr(4)
            .flex_none()
            .when(l === "└" || l === "├", (el) => el.border_b(1).rounded_bl(6)),
        ),
      )
      .when(Boolean(pic), (el) => el.child(div().mr(8).child(pic)))
      .child(
        div()
          .flex_1()
          .truncate()
          .text_color(on ? t.foreground : t.muted)
          .child(k.name || k.template || k.program?.name || k.address),
      )
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working")
      return Icon("spinner").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact)
      return div()
        .size(14)
        .flex_none()
        .rounded(4)
        .bg(t.blocked + "26")
        .text_size(TEXT.avatar)
        .font_bold()
        .text_color(t.blocked)
        .flex()
        .items_center()
        .justify_center()
        .child("!");
    if (a.status === "blocked")
      return div()
        .flex_none()
        .px(6)
        .h(18)
        .rounded(5)
        .bg(t.blocked + "26")
        .text_size(TEXT.avatar)
        .font_semibold()
        .text_color(t.blocked)
        .flex()
        .items_center()
        .child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle")
      return div()
        .size(7)
        .mx(3)
        .flex_none()
        .rounded(4)
        .border(1.5)
        .border_color(t.idle ?? t.dim);
    return div()
      .size(7)
      .mx(3)
      .flex_none()
      .rounded(4)
      .bg(a.status === "done" ? color : t.dim + "00");
  }

  // opts, from the lists view: `view` already read, `heading: false` under its tabs.
  render(opts = {}) {
    const t = theme();
    const view = opts.view ?? this.readView();
    setAgentOrder(view.list.map((a) => a.address));
    const rows = view.collapsed
      ? view.list.flatMap((a, i) => this.agentWithSubs(a, i, view, t))
      : view.groups.flatMap((group, index) => this.groupRows(group, index, view, t));

    const list = v_flex()
      .id("ag-list")
      .flex_1()
      .min_h(0)
      .px(view.collapsed ? 0 : 8)
      .overflow_y_scroll()
      .children(rows);
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      // Under the lists view's tabs, the tab bar's space divides it instead.
      .when(opts.heading !== false, (el) => el.border_t(1).border_color(t.border))
      .text_size(TEXT.body)
      .when(!view.collapsed && opts.heading !== false, (el) => el.child(this.heading(view.sort, t)))
      .when(view.list.length === 0 && !view.collapsed, (el) => el.child(this.emptyMessage(t)))
      .child(v_flex().relative().flex_1().min_h(0).child(list).child(scrollingScrollbar("ag-list")))
      .when(view.collapsed, (el) => el.child(this.expandRow(t)));
  }

  // ── What to show ──────────────────────────────────────────────────────────

  // Everything one render needs: the agents in order, in their groups.
  readView() {
    const sort = sortOf();
    const all = terminals();
    const now = Date.now();
    const unordered = agents();
    this.listed = new Map(unordered.map((a) => [a.address, a.status]));
    this.track(unordered, now);
    this.hold(unordered);
    this.prunePins(all);

    const byPriority = sort.id === "priority";
    const urgency = this.urgencies(unordered, all);
    const ordered = byPriority ? this.byUrgency(unordered, urgency) : unordered;
    const pinned = this.pins.map((p) => ordered.find((a) => a.address === p)).filter(Boolean);
    const unpinned = ordered.filter((a) => !this.pins.includes(a.address));

    const label = agentLabel();
    const groupOf = grouping(sort.id, label);
    const rest = groupOf ? gatherGroups(unpinned, groupOf, sort.id) : unpinned;
    const list = [...pinned, ...rest];
    return {
      sort,
      count: unordered.length,
      all,
      now,
      byPriority,
      collapsed: narrow(),
      shown: focused()?.agent,
      list,
      label,
      groups: this.makeGroups(pinned, rest, groupOf, byPriority, urgency),
    };
  }

  // An agent's urgency is its own or its most urgent sub-agent's.
  urgencies(list, all) {
    const kids = (a) =>
      this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0);
    return new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...kids(a))]));
  }

  byUrgency(list, urgency) {
    const rankOf = (a) => urgency.get(a.address);
    return [...list].sort(
      (x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq,
    );
  }

  // Groups in list order: spaces (grouped) or priority sections. Agents of a
  // space are next to each other in agents(), so neighbours make a group.
  makeGroups(pinned, rest, groupOf, byPriority, urgency) {
    const groups = pinned.length
      ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }]
      : [];
    for (const a of rest) {
      const rank = urgency.get(a.address) || RANK.idle;
      const group = groupOf ? groupOf(a) : { id: `sec-${rank}`, label: SECTION[rank] };
      if (groups.at(-1)?.id === group.id) groups.at(-1).members.push(a);
      else
        groups.push({ ...group, status: byPriority ? SECTION_STATUS[rank] : null, members: [a] });
    }
    return groups;
  }

  toggleFold(id, cx) {
    if (!this.folded.delete(id)) this.folded.add(id);
    cx.notify();
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  heading(sort, t) {
    return h_flex()
      .px(16)
      .h(41)
      .pt(14)
      .pb(5)
      .flex_none()
      .items_center()
      .justify_between()
      .child(div().text_size(TEXT.label).font_medium().text_color(t.dim).child("Agents"))
      .child(this.renderSortMenu(sort));
  }

  emptyMessage(t) {
    return div()
      .px(12)
      .text_size(TEXT.small)
      .text_color(t.dim)
      .child(
        "No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.",
      );
  }

  // Under the compact rail, the way back to the full sidebar.
  expandRow(t) {
    return h_flex()
      .h(28)
      .items_center()
      .justify_center()
      .child(
        div()
          .id("collapse")
          .text_size(TEXT.body)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click(toggleSidebar)
          .child("»"),
      );
  }

  groupRows(group, index, view, t) {
    const members = this.folded.has(group.id)
      ? []
      : group.members.flatMap((a, i) => this.agentWithSubs(a, i, view, t));
    return [this.groupHeader(group, index, view, t), ...members];
  }

  // Folded, a group's header also says its most urgent state.
  groupHeader(group, index, view, t) {
    const folded = this.folded.has(group.id);
    const top = group.members.reduce(
      (most, a) => ((RANK[a.status] ?? 0) > (RANK[most] ?? 0) ? a.status : most),
      null,
    );
    const showTop = folded && !view.byPriority && top && top !== "idle";
    return GroupHeader({
      id: group.id,
      label: group.label,
      count: group.members.length,
      labelColor: t[group.status],
      folded,
      divided: false,
      action: showTop ? this.status(t, { status: top }, true) : null,
      onClick: (cx) => this.toggleFold(group.id, cx),
    });
  }

  agentWithSubs(a, i, view, t) {
    if (view.collapsed) return [this.railRow(a, i, t)];
    const subs = this.tree(view.all, a.address);
    const row = this.agentRow(a, subs, view, t);
    if (this.folded.has(a.address)) return [row];
    return [row, ...subs.map((s) => this.subRow(t, s, view.shown, view.byPriority))];
  }

  railRow(a, i, t) {
    return h_flex()
      .id(`ag-${a.address}`)
      .h(26)
      .px(8)
      .flex_none()
      .items_center()
      .gap(4)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .whitespace_nowrap()
          .text_right()
          .text_color(t.muted)
          .child(String(i + 1)),
      )
      .child(
        h_flex()
          .w(14)
          .flex_none()
          .items_center()
          .justify_center()
          .child(this.status(t, a, true)),
      );
  }

  agentRow(a, subs, view, t) {
    const pic = icon(a.program, 16, t.foreground);
    const hovered = this.hovered === a.address;
    const when = this.since(a);
    // An agent on another machine (`vps/t7`) says which.
    const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
    const tabSpace = spaces().find((candidate) =>
      (candidate.tabs ?? []).some((item) => item.id === a.tab),
    );
    const tab = tabSpace?.tabs?.find((candidate) => candidate.id === a.tab);
    const space = tabSpace ?? spaces().find((candidate) => candidate.id === a.space);
    // An agent row represents its tab whenever it is shown. Make that row
    // draggable too, otherwise tabs containing agents have no tab row.
    const dragEnabled = Boolean(tab && space);
    const row = h_flex()
      .id(`ag-${a.address}`)
      .px(8)
      .h(30)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(9)
      .when(dragEnabled, (el) => el.relative())
      .when(a.focused, (el) => el.bg(t.selected))
      .when(this.tabDrag?.active && this.tabDrag.id === tab?.id, (el) => el.opacity(0.45))
      .when(this.tabDrag?.active && dragEnabled, (el) => el.cursor_grab())
      .when(!this.tabDrag?.active, (el) => el.cursor_pointer())
      .hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hovered = a.address;
        else if (hovered) this.hovered = null;
        if (dragEnabled) this.hoverTabRow(space, tab, on, cx);
        cx.notify();
      })
      .on_click(() => {
        if (Date.now() < (this.ignoreTabClickUntil ?? 0)) return;
        run("pane.focus", { pane: a.pane });
      })
      .when(dragEnabled, (el) =>
        el
          .on_mouse_down("left", (event, cx) => this.beginTabDrag(space, tab, event, cx))
          .on_mouse_move((event, cx) => this.hoverTab(space, tab, event, cx))
          .on_mouse_up("left", (event, cx) => this.finishTabDrag(space, tab, event, cx)),
      )
      .when(Boolean(pic), (el) => el.child(this.agentIcon(a, pic, subs)))
      .child(this.agentName(a, view, t))
      .when(Boolean(machine), (el) =>
        el.child(div().text_size(TEXT.badge).text_color(t.dim).child(machine)),
      )
      .when(subs.length > 0, (el) => el.child(this.foldButton(a, subs, t)))
      .when(hovered, (el) => el.child(this.pinButton(a, t)))
      .when(!hovered && Boolean(when), (el) =>
        el.child(
          div()
            .flex_none()
            .text_size(TEXT.caption)
            .text_color(t.dim)
            .child(duration(view.now - when)),
        ),
      )
      .child(this.status(t, a, view.byPriority && !this.pins.includes(a.address)));
    if (dragEnabled && this.tabDrag?.active && this.tabDrag.target?.id === tab.id && this.tabDrag.id !== tab.id)
      row.child(this.tabDropLine(this.tabDrag.target.after, t));
    return row;
  }

  // A tab with no agent, under its space in the lists view: its program and its name.
  tabRow(w, tab, lit, t) {
    const ps = panes();
    const l = tabLead(tab, ps, focused());
    // The tab's title, as Herdr's tab bar shows it.
    const name = automaticTabTitle(tab, l, shared("pane-heads")?.[l?.pane]?.title);
    const prog = l?.program?.name;
    // A mod's pane runs no program, but the mod may publish an icon, as Better Tabs reads it.
    const modIcon = shared("mod-icons")?.[panes().find((p) => p.tab === tab.id && p.mod)?.mod];
    const pic =
      icon(l?.program, 16, t.dim) ?? (modIcon ? svg(modIcon).size(16).flex_none().text_color(t.dim) : null);
    const row = h_flex()
      .id(`tab-${tab.id}`)
      .px(8)
      .h(30)
      .flex_none()
      .rounded(6)
      .items_center()
      .gap(9)
      .relative()
      .when(lit, (el) => el.bg(t.selected))
      .when(this.tabDrag?.active && this.tabDrag.id === tab.id, (el) => el.opacity(0.45))
      .when(this.tabDrag?.active, (el) => el.cursor_grab())
      .when(!this.tabDrag?.active, (el) => el.cursor_pointer())
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (event, cx) => this.beginTabDrag(w, tab, event, cx))
      .on_mouse_move((event, cx) => this.hoverTab(w, tab, event, cx))
      .on_mouse_up("left", (event, cx) => this.finishTabDrag(w, tab, event, cx))
      .on_hover((hovered, cx) => this.hoverTabRow(w, tab, hovered, cx))
      .child(pic ?? div().w(16).flex_none())
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(5)
          .items_center()
          .child(div().min_w(0).truncate().text_color(lit ? t.foreground : t.muted).child(name))
          .when(Boolean(prog) && prog !== name, (el) => el.child(this.programName(prog, t))),
      );
    if (this.tabDrag?.active && this.tabDrag.target?.id === tab.id && this.tabDrag.id !== tab.id)
      row.child(this.tabDropLine(this.tabDrag.target.after, t));
    return row;
  }

  tabDropLine(after, t) {
    return div()
      .absolute()
      .left(0)
      .right(0)
      .h(2)
      .bg(t.accent)
      .when(after, (line) => line.bottom(0))
      .when(!after, (line) => line.top(0));
  }

  tabDragReady(drag, point) {
    return (
      Date.now() - drag.pressedAt >= TAB_DRAG_DELAY_MS &&
      Math.hypot(point.x - drag.start.x, point.y - drag.start.y) >= TAB_DRAG_DISTANCE
    );
  }

  beginTabDrag(space, tab, event, cx) {
    // Keep the press on the tab row while the pointer crosses sibling rows.
    // This is the same propagation boundary used by Herdr's shipped tab bar.
    cx.stop_propagation();
    const point = event.position ?? { x: 0, y: 0 };
    this.tabDrag = {
      id: tab.id,
      space: space.id,
      start: point,
      point,
      pressedAt: Date.now(),
      active: false,
      target: null,
    };
    this.tabRows.clear();
    this.rememberTabRow(space, tab, event);
    cx.notify();
  }

  hoverTab(space, tab, event, cx) {
    this.rememberTabRow(space, tab, event);
    const drag = this.tabDrag;
    if (!drag || drag.space !== space.id) return;
    const point = event.position ?? drag.point;
    drag.point = point;
    drag.active ||= this.tabDragReady(drag, point);
    if (!drag.active) return;
    const bounds = event.bounds;
    const localY = event.local_position?.y ?? 0;
    const after = bounds ? localY > bounds.height / 2 : false;
    const target = drag.id === tab.id ? null : { id: tab.id, after };
    if (!drag.target || drag.target.id !== target?.id || drag.target.after !== target?.after) {
      drag.target = target;
      cx.notify();
    }
  }

  rememberTabRow(space, tab, event) {
    if (!event?.bounds || !space || !tab) return;
    this.tabRows.set(tab.id, { space: space.id, bounds: event.bounds });
  }

  // GPUI can keep mouse-move delivery on the pressed row while the pointer
  // crosses the scroll list. The list container still sees the window point;
  // use the row bounds observed during hover to update the drop target.
  moveTabDrag(event, cx) {
    const drag = this.tabDrag;
    if (!drag) return;
    const point = event.position ?? drag.point;
    drag.point = point;
    drag.active ||= this.tabDragReady(drag, point);
    if (!drag.active) return;
    let target = null;
    for (const [id, row] of this.tabRows) {
      if (row.space !== drag.space || id === drag.id) continue;
      const b = row.bounds;
      if (!b || point.y < b.y || point.y > b.y + b.height) continue;
      target = { id, after: point.y > b.y + b.height / 2 };
      break;
    }
    if (!target || drag.target?.id !== target.id || drag.target.after !== target.after) {
      drag.target = target;
      cx.notify();
    }
  }

  // Hover is a fallback for compact rows: GPUI can keep mouse-move delivery
  // on the pressed row while the pointer crosses a sibling row.
  hoverTabRow(space, tab, hovered, cx) {
    const drag = this.tabDrag;
    if (!hovered || !drag || drag.space !== space.id || drag.id === tab.id) return;
    drag.active = true;
    const current = spaces().find((candidate) => candidate.id === space.id);
    const from = current?.tabs?.findIndex((candidate) => candidate.id === drag.id) ?? -1;
    const target = current?.tabs?.findIndex((candidate) => candidate.id === tab.id) ?? -1;
    if (from < 0 || target < 0) return;
    const next = { id: tab.id, after: from < target };
    if (!drag.target || drag.target.id !== next.id || drag.target.after !== next.after) {
      drag.target = next;
      cx.notify();
    }
  }

  finishTabDrag(space, tab, event, cx) {
    const drag = this.tabDrag;
    if (!drag) return;
    cx.stop_propagation();
    this.hoverTab(space, tab, event, cx);
    this.commitTabDrag(cx, tab.id, space.id);
  }

  // The scroll viewport also receives a release when the pointer leaves the
  // pressed row. Commit there as a fallback; a row release has already cleared
  // the state, so this is a no-op in the normal path.
  commitTabDrag(cx, clickedID = null, spaceID = null) {
    const drag = this.tabDrag;
    if (!drag) return;
    this.tabDrag = null;
    this.tabRows.clear();
    const current = spaces().find((candidate) => candidate.id === drag.space);
    const target = current && (!spaceID || current.id === spaceID) ? drag.target : null;
    if (current && target) {
      const index = tabMoveIndex(current.tabs ?? [], drag.id, target.id, target.after);
      if (index !== null) {
        run("tab.move", { id: drag.id, index });
        this.ignoreTabClickUntil = Date.now() + 300;
      }
    } else if (!drag.active && clickedID && current) {
      run("space.select", { id: current.id });
      run("tab.select", { id: clickedID });
    }
    cx.notify();
  }

  cancelTabDrag(cx) {
    if (!this.tabDrag) return;
    this.tabDrag = null;
    this.tabRows.clear();
    cx.notify();
  }

  // The program, quietly after a row's name under its space.
  programName(prog, t) {
    return div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(prog);
  }

  // With sub-agents, clicking the icon folds them.
  agentIcon(a, pic, subs) {
    return div()
      .id(`agent-fold-${a.address}`)
      .when(subs.length > 0, (el) =>
        el.on_click((_e, cx) => {
          cx.stop_propagation();
          this.toggleFold(a.address, cx);
        }),
      )
      .child(pic);
  }

  // The tab's title, then quietly its space; nested under its space's row, its program.
  agentName(a, view, t) {
    const namesSpace = !view.nested;
    // Keep agent rows on the same title rule as the tab bar. This matters for
    // terminals, file/diff panes, and split tabs whose active pane changes.
    const tab = spaces().flatMap((s) => s.tabs ?? []).find((candidate) => candidate.id === a.tab);
    const lead = tab ? tabLead(tab, panes(), focused()) : null;
    const name = tab
      ? automaticTabTitle(tab, lead, shared("pane-heads")?.[lead?.pane]?.title)
      : a.title || a.program?.name || "";
    const prog = a.program?.name;
    const idle = a.status === "idle" && !a.focused;
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .items_center()
      .child(
        div()
          .min_w(0)
          .max_w(namesSpace ? 140 : 200)
          .truncate()
          .text_color(idle ? t.muted : t.foreground)
          .child(name),
      )
      // The space, quietly after the name.
      .when(namesSpace && Boolean(a.space_name), (el) =>
        el.child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(a.space_name)),
      )
      // Under its space, the program instead.
      .when(view.nested && Boolean(prog) && prog !== name, (el) => el.child(this.programName(prog, t)));
  }

  // The fold chevron; folded, the count too, colored by the most urgent one.
  foldButton(a, subs, t) {
    const statuses = subs.map((s) => kidStatus(s.t, this.listed));
    const top = statuses.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
    const open = !this.folded.has(a.address);
    return div()
      .id(`fold-${a.address}`)
      .h(18)
      .px(3)
      .gap(3)
      .flex()
      .items_center()
      .rounded(4)
      .text_size(TEXT.caption)
      .text_color(open ? t.dim : (t[top] ?? t.dim))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.toggleFold(a.address, cx);
      })
      .child(Icon(`chevron-${open ? "down" : "right"}`, 11))
      .when(!open, (el) => el.child(String(subs.length)));
  }

  pinButton(a, t) {
    const pinned = this.pins.includes(a.address);
    return div()
      .id(`pin-${a.address}`)
      .flex_none()
      .p(2)
      .rounded(4)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(pinned ? "Unpin" : "Pin to the top")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.setPins(pinned ? this.pins.filter((p) => p !== a.address) : [...this.pins, a.address]);
        // The row moves away from under the pointer, and no hover-out comes.
        this.hovered = null;
        cx.notify();
      })
      .child(Icon(pinned ? "pin-off" : "pin", 13));
  }
}

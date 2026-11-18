// Adapted from Herdr App's picker (herdrdev/herdr-app, Apache-2.0).
// XMux adds machine-qualified spaces, live tab titles and split Agent targets.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, spaces, panes, focused, terminals, run, hc, exec, theme, settings, props, closeOverlay, shared } from "herdr";
import { automaticTabTitle, tabLead } from "./shared/tab-title.js";

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

function spaceColor(t, p) {
  if (p.name === "~") return t.dim;
  const c = shared("space.colors")?.[p.id] ?? "ansi6";
  return c.startsWith("#") ? c : (MARK[c] ?? t[c]);
}

function tabTargets(w, ctx, all, ps, current, heads) {
  const mine = all.filter((a) => a.tab === ctx.id);
  const lead = tabLead(ctx, ps, current);
  const title = automaticTabTitle(ctx, lead, heads[lead?.pane]?.title);
  const tab = { kind: "ctx", w, ctx, mine, title, id: ctx.id };
  const agentRows = mine.length > 1 ? mine.flatMap((agent) => {
    const pane = ps.find((item) => item.pane === agent.pane) ?? { ...agent, terminal: agent.address };
    const fallback = agent.program?.name || agent.address;
    const agentTitle = automaticTabTitle({ name: fallback }, pane);
    if (agent.pane === lead?.pane && agentTitle === title) return [];
    return [{ kind: "ctx", w, ctx, mine: [agent], title: agentTitle, agent, id: `${ctx.id}/${agent.address}` }];
  }) : [];
  return [tab, ...agentRows];
}

export default class Picker extends View {
  init(_props, cx) {
    this.filter = "";
    this.input = InputState.new({ placeholder: "Go to a tab, space or agent…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = this.filter ? Math.max(0, this.rows().filter(r => r.kind !== "head").findIndex(r => r.kind === "ctx")) : 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.go(this.rows().filter(r => r.kind !== "head")[this.at], cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.at = null;
    this.scroll = 0;
    this.showEarlier = false;
    this.machines = [];
    this.localHost = "Local";
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => m.state === "connected" && !m.temporary).map((m) => m.name);
      } catch {}
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        const result = await exec("hostname", [], { on: null, timeout: 1500 });
        if (result.code === 0 && result.stdout.trim()) this.localHost = result.stdout.trim();
      } catch {}
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  rows() {
    const f = this.filter.toLowerCase();
    const all = agents();
    const ps = panes();
    const current = focused();
    const heads = shared("pane-heads") ?? {};
    const live = terminals().filter((x) => x.state === "live");
    const teamOf = (addrs) => {
      let n = 0;
      const walk = (a) => live.filter((x) => x.parent === a).forEach((k) => (n++, walk(k.address)));
      addrs.forEach(walk);
      return n;
    };
    const groups = spaces().map((w) => {
      const label = `${w.machine ?? this.localHost}/${w.name}`;
      const ctxs = w.tabs
        .flatMap((ctx) => tabTargets(w, ctx, all, ps, current, heads))
        .filter((c) => !f || [label, c.title, c.ctx.name, ...c.mine.map((a) => a.program?.name ?? "")].join(" ").toLowerCase().includes(f));
      return { w, label, ctxs };
    });
    const busy = groups.filter((p) => p.w.status && p.ctxs.length);
    const quiet = groups.filter((p) => !p.w.status && p.ctxs.length);
    busy.sort((a, b) => (b.w.status === "blocked") - (a.w.status === "blocked"));
    const out = [];
    const add = (p) => {
      out.push({ kind: "head", w: p.w, label: p.label });
      for (const c of p.ctxs) out.push({ ...c, team: teamOf(c.mine.map((a) => a.address)) });
    };
    busy.forEach(add);
    if (quiet.length) {
      out.push({ kind: "earlier", count: quiet.length });
      if (this.showEarlier || f) quiet.forEach(add);
    }
    out.push({ kind: "new" });
    out.push({ kind: "space", machine: null });
    for (const m of this.machines) out.push({ kind: "space", machine: m });
    return out;
  }

  go(r, cx) {
    if (!r) return;
    if (r.kind === "earlier") {
      this.at = this.rows().filter(r => r.kind !== "head").findIndex(r => r.kind === "earlier");
      this.showEarlier = !this.showEarlier;
      this.input.focus();
      cx.notify();
      return;
    }
    this.close();
    if (r.agent) run("pane.focus", { pane: r.agent.pane });
    else if (r.kind === "ctx") run("tab.select", { id: r.ctx.id });
    else if (r.kind === "new") run("tab.new");
    else if (r.kind === "space") run("space.new", { machine: r.machine ?? "" });
  }

  glyph(t, st) {
    if (st === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    return div().w(12).flex_none().text_color(t[st] ?? t.dim).child(st === "idle" ? "○" : st ? "●" : "·");
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const pickable = rows.filter((r) => r.kind !== "head");
    // Opens on where you are.
    if (this.at === null) this.at = Math.max(0, pickable.findIndex((r) => r.kind === "ctx" && r.w.active && r.ctx.active));
    this.at = Math.min(this.at, pickable.length - 1);
    const sel = pickable[this.at];
    // One continuous strip: each row (and the group title before it) at a fixed
    // y. Scrolling moves the strip only as far as it takes to keep the selected
    // row in view, so the arrows can't run the selection off the list.
    const H = { head: 29, earlier: 35, new: 36, ctx: 32, space: 32 };
    const tops = [];
    let y = 0;
    rows.forEach((r) => { tops.push(y); y += H[r.kind] ?? 32; });
    const total = y;
    const height = Math.min(320, this.listHeight ?? 320);
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const si = rows.indexOf(sel);
    if (si >= 0) {
      if (tops[si] < this.scroll) this.scroll = tops[si];
      if (tops[si] + (H[sel.kind] ?? 32) > this.scroll + height) this.scroll = tops[si] + (H[sel.kind] ?? 32) - height;
    }
    const place = (el, i) =>
      fixed
        ? el.absolute().left(0).right(0).top(tops[i] - this.scroll).bottom(height - (tops[i] + (H[rows[i].kind] ?? 32) - this.scroll))
        : el;
    const visible = (i) => !fixed || (tops[i] + (H[rows[i].kind] ?? 32) > this.scroll && tops[i] < this.scroll + height);

    const row = (r) => {
      if (r.kind === "head") {
        return h_flex()
          .px(10)
          .pt(10)
          .pb(3)
          .gap(8)
          .items_center()
          .text_size(11)
          .font_semibold()
          .text_color(t.dim)
          .child(h_flex().size(18).rounded(5).bg(spaceColor(t, r.w)).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...r.w.name][0]?.toUpperCase() ?? "?"))
          .child(div().min_w(0).truncate().tooltip(r.label).child(r.label));
      }
      if (r.kind === "earlier") {
        return h_flex()
          .id("pk-earlier")
          .mt(6)
          .px(10)
          .py(6)
          .border_t(1)
          .border_color(t.border)
          .text_size(12)
          .text_color(t.dim)
          .cursor_pointer()
          .when(r === sel, (el) => el.bg(t.hover).text_color(t.foreground))
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.go(r, cx))
          .child(`earlier: ${r.count} quiet space${r.count > 1 ? "s" : ""} ${this.showEarlier ? "▴" : "▾"}`);
      }
      const on = r === sel;
      if (r.kind === "new" || r.kind === "space") {
        const label = r.kind === "new" ? "new tab" : r.machine ? `new space on ${r.machine}` : "new space";
        return h_flex()
          .id(r.kind === "new" ? "pk-new" : `pk-space-${r.machine ?? "here"}`)
          .mx(4)
          .when(r.kind === "new", (el) => el.mt(4))
          .px(10)
          .h(32)
          .items_center()
          .rounded(7)
          .gap(8)
          .text_color(t.muted)
          .cursor_pointer()
          .when(on, (el) => el.bg(t.hover))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.go(r))
          .child(div().w(12).child("+"))
          .child(label);
      }
      const who = [...new Set(r.mine.map((a) => a.program?.name ?? "Agent"))].join(" · ");
      const here = r.w.active && r.ctx.active && (!r.agent || r.agent.focused);
      const status = r.agent?.status ?? r.ctx.status;
      return h_flex()
        .id(`pk-${r.id}`)
        .mx(4)
        .px(10)
        .h(32)
        .rounded(7)
        .gap(10)
        .items_center()
        .when(Boolean(r.agent), (el) => el.pl(28))
        .cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.go(r))
        .child(this.glyph(t, status))
        .child(div().flex_1().min_w(0).truncate().tooltip(r.title).text_color(t.foreground).when(here, (d) => d.font_semibold()).child(r.title))
        .when(status === "blocked", (el) => el.child(div().text_size(11).text_color(t.blocked).child("needs you")))
        .when(status === "done", (el) => el.child(div().text_size(11).text_color(t.done).child("finished")))
        .child(div().text_size(11).text_color(t.dim).child(who + (r.team ? `  +${r.team}` : "")));
    };

    return v_flex()
      .id("picker")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "down") this.at = (this.at + 1) % pickable.length;
        else if (k === "up") this.at = (this.at + pickable.length - 1) % pickable.length;
        else if (k === "d" && e.modifiers.control) {
          if (sel?.kind === "ctx" && !sel.agent) {
            this.close();
            run("tab.close", { id: sel.ctx.id });
          }
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Go to…")).child(div().id("picker-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(
        h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
          .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)),
      )
      .child(
        v_flex()
          .id("pk-list")
          .on_size_change((size, cx) => {
            this.listHeight = size.height / settings().zoom;
            cx.notify();
          })
          .h(Math.min(320, total))
          .min_h(0)
          .mb(6)
          .when(fixed, (el) =>
            el.overflow_hidden().on_scroll_wheel((e, cx) => {
              this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
              // The selection follows the wheel, so the next frame doesn't scroll back to it.
              while (this.at < pickable.length - 1 && tops[rows.indexOf(pickable[this.at])] < this.scroll) this.at++;
              while (this.at > 0 && tops[rows.indexOf(pickable[this.at])] + (H[pickable[this.at].kind] ?? 32) > this.scroll + height) this.at--;
              cx.notify();
            }))
          .children(rows.map((r, i) => (visible(i) ? place(row(r), i) : null)).filter(Boolean)),
      );
  }
}

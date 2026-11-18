import { div } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle } from "gpui-base";
import { agents, closeOverlay, machines, props, spaces, theme } from "herdr";
import { pasteIntoChat } from "../shared/chat-menu.js";
import { automaticTabTitle } from "../shared/tab-title.js";
import { Button, TEXT } from "./ui.js";

export const chatPickerMethods = {
  initChatPicker(target, cx) {
    this.chatTarget = target;
    const list = spaces();
    const current = list.find((space) => space.active);
    this.chatMachine = current?.machine ?? null;
    this.chatColumn = "agent";
    this.chatFocus = cx.focus_handle();
    this.machineScroll = ScrollHandle.new();
    this.agentScroll = ScrollHandle.new();
    const spacesHere = new Set(list.filter((space) => (space.machine ?? null) === this.chatMachine).map((space) => space.id));
    const onMachine = agents().filter((agent) => spacesHere.has(agent.space));
    const initialAgent = onMachine.findIndex((agent) => agent.space === current?.id);
    this.chatAgent = onMachine[initialAgent]?.address;
    this.agentScroll.scroll_to_item(Math.max(0, initialAgent));
    this.machineScroll.scroll_to_item(chatMachines().indexOf(this.chatMachine));
    this.chatFocus.focus();
  },

  pickMachine(machine, index) {
    this.chatMachine = machine;
    this.chatAgent = null;
    this.chatColumn = "machine";
    this.machineScroll.scroll_to_item(index);
    this.agentScroll.scroll_to_item(0);
  },

  pickAgent(agent, index) {
    this.chatAgent = agent.address;
    this.chatColumn = "agent";
    this.agentScroll.scroll_to_item(index);
  },

  addToPickedChat(selected, overlay, cx) {
    if (!selected || this.addingChat) return;
    this.addingChat = true;
    cx.notify();
    cx.spawn(async (cx) => {
      if (await pasteIntoChat(this.chatTarget, selected, cx)) closeOverlay(overlay);
      this.addingChat = false;
      cx.notify();
    });
  },

  chatPickerKey(event, cx, machineList, onMachine, selected, overlay) {
    if (event.modifiers?.control || event.modifiers?.platform || event.modifiers?.alt) return;
    if (!["up", "down", "left", "right", "tab", "enter", "escape"].includes(event.key)) return;
    cx.stop_propagation();
    if (this.addingChat) return;
    const machineColumn = this.chatColumn === "machine";
    if (event.key === "escape") {
      closeOverlay(overlay);
      return;
    }
    if (event.key === "enter" && !machineColumn) {
      this.addToPickedChat(selected, overlay, cx);
      return;
    }
    if (event.key === "left" || event.key === "right" || event.key === "tab" || event.key === "enter") {
      this.chatColumn = (event.key === "left" || event.key === "tab" && !machineColumn) ? "machine" : "agent";
    } else {
      const direction = event.key === "down" ? 1 : -1;
      const choices = machineColumn ? machineList : onMachine;
      const current = machineColumn ? this.chatMachine : selected;
      if (choices.length) {
        const next = (Math.max(0, choices.indexOf(current)) + direction + choices.length) % choices.length;
        if (machineColumn) this.pickMachine(machineList[next], next);
        else this.pickAgent(onMachine[next], next);
      }
    }
    cx.notify();
  },

  chatPickerView() {
    const t = theme();
    const list = spaces();
    const spaceById = new Map(list.map((space) => [space.id, space]));
    const onMachine = agents().filter((agent) =>
      spaceById.has(agent.space) && (spaceById.get(agent.space).machine ?? null) === this.chatMachine);
    const selected = onMachine.find((agent) => agent.address === this.chatAgent) ?? onMachine[0];
    const overlay = props().overlay;
    const row = (id, label, active, column, select, detail, activate) => v_flex()
      .id(id).gap(2).px(8).py(5).rounded(4).flex_none().cursor_pointer()
      .role("list_box_option").aria_selected(active)
      .bg(active ? t.selected : t.background)
      .when(active && this.chatColumn === column, (el) => el.aria_active_descendant().text_color(t.accent))
      .hover((el) => el.bg(t.hover)).on_click((event, cx) => {
        if (this.addingChat) return;
        select();
        this.chatFocus.focus();
        if (event.click_count === 2 && activate) activate(cx);
        else cx.notify();
      })
      .child(div().truncate().child(label))
      .when(Boolean(detail), (el) => el.child(div().truncate().text_size(TEXT.caption).text_color(t.dim).child(detail)));
    const machineList = chatMachines();
    return v_flex().id("chat-picker").size_full().gap(8).p(12).bg(t.background).text_color(t.foreground).text_size(TEXT.body)
      .track_focus(this.chatFocus).on_key_down((event, cx) => this.chatPickerKey(event, cx, machineList, onMachine, selected, overlay))
      .child(div().font_medium().child("Add to other chat"))
      .child(div().truncate().text_color(t.dim).child(this.chatTarget.relative || this.chatTarget.path || this.chatTarget.url))
      .child(h_flex().flex_1().min_h(0).gap(8)
        .child(v_flex().id("chat-machines").w(128).flex_none().gap(2).overflow_y_scrollbar()
          .role("list_box").accessibility_label("Machines").track_scroll(this.machineScroll)
          .children(machineList.map((machine, index) => row(`chat-machine-${machine ?? "local"}`, machine ?? "Local",
            machine === this.chatMachine, "machine", () => this.pickMachine(machine, index)))))
        .child(v_flex().id("chat-agents").flex_1().min_w(0).gap(2).overflow_y_scrollbar()
          .role("list_box").accessibility_label("Agents").track_scroll(this.agentScroll)
          .when(!onMachine.length, (el) => el.child(div().px(8).py(5).text_color(t.dim).child("No running Agents")))
          .children(onMachine.map((agent, index) => {
            const space = spaceById.get(agent.space);
            const tab = space.tabs?.find((item) => item.id === agent.tab) ?? { name: agent.program?.name || agent.address };
            const title = automaticTabTitle(tab, { ...agent, terminal: agent.address });
            return row(`chat-agent-${agent.address}`, title, agent.address === selected?.address,
              "agent", () => this.pickAgent(agent, index), space.name,
              (cx) => this.addToPickedChat(agent, overlay, cx));
          }))))
      .child(h_flex().justify_end().gap(8)
        .child(Button({ id: "chat-cancel", label: "Cancel", disabled: this.addingChat, onClick: () => closeOverlay(overlay) }))
        .child(Button({ id: "chat-add", label: "Add", primary: true, disabled: this.addingChat || !selected,
          onClick: (cx) => this.addToPickedChat(selected, overlay, cx) })));
  },
};

function chatMachines() {
  return [...new Set([null, ...machines().map((machine) => machine.name)])];
}

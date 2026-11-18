import { agents, exec, focused, notify, openOverlay, panes, run, spaces, terminals } from "herdr";

export function currentChat() {
  const focus = focused();
  if (!focus?.pane || !terminals().some((item) => item.address === focus.terminal && item.state === "live")) return null;
  return agents().find((agent) => agent.pane === focus.pane && agent.address === focus.terminal) ?? null;
}

function chatReference(target, agent, samePane, localHost) {
  if (target.url) return target.url;
  const space = spaces().find((item) => item.id === agent.space);
  const source = target.on ?? null;
  const destination = space?.machine ?? null;
  if (source !== destination) return `${source ?? localHost}:${target.path}`;
  if (!samePane && target.space !== agent.space) return target.path;
  const cwd = panes().find((pane) => pane.pane === agent.pane)?.cwd || target.root || space?.folder;
  if (!cwd?.startsWith("/")) return target.relative ?? target.path;
  const from = cwd.split("/").filter(Boolean);
  const to = target.path.split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && from[common] === to[common]) common++;
  return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/") || ".";
}

export function chatText(target, agent, samePane = false, localHost = "") {
  return ` ${chatReference(target, agent, samePane, localHost)} `;
}

export function chatItems(target) {
  return [
    { id: "add-to-chat", label: "Add to chat", disabled: !currentChat(), run: (cx) => {
      const agent = currentChat();
      if (agent) return pasteIntoChat(target, agent, cx, true);
    } },
    { id: "add-to-other-chat", label: "Add to other chat", run: () => {
      openOverlay({ mod: "xmux-files", kind: "dialog", width: 560, height: 400,
        props: { mode: "chat-picker", target } });
    } },
  ];
}

// Herdr's terminal paste inserts at the current cursor without submitting.
// Verify the selected terminal after the focus command before invoking paste.
export function pasteIntoChat(target, agent, cx, samePane = false) {
  return new Promise((resolve) => {
    const failed = (body = "The selected Agent is no longer available.") => {
      notify({ title: "Add to chat", body, level: "error" });
      resolve(false);
    };
    cx.spawn(async (cx) => {
      try {
        const destination = spaces().find((space) => space.id === agent.space)?.machine;
        let localHost;
        if (!target.url && !target.on && destination) {
          const reply = await exec("hostname", [], { on: null, timeout: 2000 });
          localHost = reply.code === 0 && reply.stdout.trim();
          if (!localHost) return failed("Could not read this computer's hostname.");
        }
        const liveAgent = () => agents().find((item) => item.address === agent.address && item.pane === agent.pane &&
          item.space === agent.space && terminals().some((terminal) => terminal.address === item.address && terminal.state === "live"));
        if (!liveAgent()) return failed();
        if (focused()?.terminal !== agent.address) {
          const deadline = Date.now() + 1800;
          run("pane.focus", { pane: agent.pane });
          do {
            await cx.sleep(50);
          } while (focused()?.terminal !== agent.address && Date.now() < deadline);
        }
        const live = liveAgent();
        if (!live || focused()?.terminal !== agent.address) return failed();
        const previous = cx.read_from_clipboard();
        const text = chatText(target, live, samePane, localHost);
        cx.write_to_clipboard(text);
        run("terminal.paste");
        await cx.sleep(100);
        if (previous !== undefined && cx.read_from_clipboard() === text) cx.write_to_clipboard(previous);
        resolve(true);
      } catch (error) {
        failed(error.message);
      }
    });
  });
}

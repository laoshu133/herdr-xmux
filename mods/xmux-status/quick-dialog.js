import { appHome, checking, closeOverlay, focused, hc, home, notify, openOverlay, run, setShared, shared, terminals } from "herdr";
import { dismissChildPreview } from "./shared/child-preview.js";

const STATE = "xmux.quick-dialog";
const LABEL = "xmux.quick-dialog";

function result(reply) {
  if (reply.code !== 0) throw new Error(reply.stderr.trim() || "Could not start the local terminal.");
  return JSON.parse(reply.stdout);
}

export class QuickDialog {
  init() {
    this.busy = false;
    this.owner = appHome();
    if (!checking()) {
      const state = shared(STATE);
      if (state?.overlay) closeOverlay(state.overlay);
      setShared(STATE, { ...state, overlay: null });
    }
  }

  async toggle() {
    if (checking() || this.busy) return;
    this.busy = true;
    try {
      if (dismissChildPreview()) return;
      const state = shared(STATE);
      if (state?.overlay) {
        closeOverlay(state.overlay);
        setShared(STATE, { ...state, overlay: null });
        return;
      }

      const origin = focused();
      let terminal = null;
      if (state?.terminal && !state.terminal.includes("/")) {
        const reply = await hc(["get", state.terminal, "--json"]);
        if (reply.code === 0) {
          const saved = JSON.parse(reply.stdout);
          if (saved.state === "live" && saved.labels?.[LABEL] === this.owner) terminal = saved.address;
          else if (saved.state !== "live" && saved.labels?.[LABEL] === this.owner) await hc(["rm", saved.address]);
        } else if (reply.code !== 3) throw new Error(reply.stderr.trim() || "Could not reconnect to the local terminal.");
      }
      if (!terminal) {
        // A labelled terminal without Herdr space/tab labels is intentionally
        // outside the normal tab tree. Never inherit the selected remote host
        // or the agent terminal that happens to launch hc.
        const existing = terminals().find(t => !t.address.includes("/") && t.state === "live" && t.labels?.[LABEL] === this.owner);
        terminal = existing?.address;
        if (!terminal) {
          const folder = origin?.terminal && !origin.terminal.includes("/") ? origin.cwd || home() : home();
          const started = result(await hc(["run", "--json", "--bg", "--no-parent", "--no-notify", "--rm", "--cwd", folder, "--label", `${LABEL}=${this.owner}`]));
          terminal = started.address;
          if (!terminal) throw new Error("The local terminal did not return an address.");
        }
      }

      const overlay = openOverlay({
        kind: "dialog",
        modal: true,
        width: 0.72,
        height: 0.64,
        layout: {
          type: "column",
          children: [
            { type: "block", size: { px: 32 }, content: { mod: "xmux-quick-dialog", props: { terminal } } },
            { type: "block", content: { terminal } },
          ],
        },
      });
      setShared(STATE, { terminal, overlay });
    } catch (error) {
      notify({ title: "Local terminal", body: String(error.message ?? error), level: "error" });
    } finally {
      this.busy = false;
    }
  }

  closeCurrent() {
    const state = shared(STATE);
    const target = focused();
    // A status-mod reload can forget the overlay id while its terminal still
    // holds focus. Never let Cmd+W fall through to the underlying tab then.
    if (state?.terminal && target?.terminal === state.terminal) {
      run("terminal.kill", { terminal: state.terminal });
      if (state.overlay) closeOverlay(state.overlay);
      setShared(STATE, null);
      return;
    }
    // Use Herdr's close-key routing so an open dialog gets the key even
    // when its terminal no longer holds keyboard focus.
    window.dispatch_action("tab.close");
  }
}

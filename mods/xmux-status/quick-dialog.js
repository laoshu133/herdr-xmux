import { appHome, checking, closeOverlay, exec, focused, hc, home, notify, openOverlay, panes, run, setShared, shared, terminals } from "herdr";

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
      // Overlay ids cannot be trusted across app starts or layout changes.
      // A fixed window key also replaces any survivor of a status-mod reload.
      setShared(STATE, { ...shared(STATE), overlay: null });
    }
  }

  async toggle() {
    if (checking() || this.busy) return;
    this.busy = true;
    let terminalToFocus;
    try {
      const state = shared(STATE);
      if (state?.overlay) {
        closeOverlay(state.overlay);
        setShared(STATE, { ...state, overlay: null });
        this.restore(state);
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
        kind: "window",
        key: "xmux-quick-dialog",
        width: 0.72,
        height: 0.64,
        layout: {
          type: "column",
          children: [
            { type: "block", size: { px: 32 }, content: { mod: "xmux-quick-dialog", props: { terminal, origin } } },
            { type: "block", content: { terminal } },
          ],
        },
      });
      setShared(STATE, { terminal, overlay, origin });
      terminalToFocus = terminal;
    } catch (error) {
      notify({ title: "Local terminal", body: String(error.message ?? error), level: "error" });
    } finally {
      this.busy = false;
    }

    if (terminalToFocus) {
      // run() queues a UI command: its eventual errors cannot be caught here.
      // The control CLI returns unsupported overlay targets without a toast.
      // Try on every show so upstream support works without a version check.
      // Keep this outside the busy section so hiding never waits for focus.
      try {
        await exec("env", [`HERDR_APP_HOME=${this.owner}`, "herdr-app", "do", "pane.focus", JSON.stringify({ terminal: terminalToFocus })], { on: null, timeout: 2000 });
      } catch {
        // Optional: older clients, a missing CLI or a timeout leave the window
        // usable by clicking its terminal. Nonzero CLI results do the same.
      }
    }
  }

  restore(state) {
    const origin = state?.origin;
    const current = focused();
    // Hiding a background window must not undo navigation since it opened.
    if (current?.terminal !== state?.terminal || (origin?.tab && current?.tab !== origin.tab)) return;
    if (origin?.pane && panes().some(p => p.pane === origin.pane)) run("pane.focus", { pane: origin.pane });
    else if (origin?.terminal && terminals().some(t => t.address === origin.terminal && t.state === "live")) run("pane.focus", { terminal: origin.terminal });
  }

  closeCurrent() {
    const state = shared(STATE);
    // A status-mod reload can forget the overlay id while its terminal still
    // holds focus. Never let Cmd+W fall through to the underlying tab then.
    if (!state?.terminal || focused()?.terminal !== state.terminal) {
      run("tab.close");
      return;
    }
    run("terminal.kill", { terminal: state.terminal });
    if (state.overlay) closeOverlay(state.overlay);
    setShared(STATE, null);
    this.restore(state);
  }
}

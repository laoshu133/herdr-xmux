// Local apps open local paths directly. VS Code can also open a path through
// the SSH connection already configured for a Herdr machine.
import { appHome, exec, hc, knownAgents, readTextFile, setShared, shared, window } from "herdr";
import { EDITORS } from "../files/model.js";

const FOUND = "xmux-files.editors";
const ERROR = "xmux-files.error";
const VSCODE = "com.microsoft.VSCode";

export const foundEditors = () => shared(FOUND) ?? [];

export function remoteVsCodeUri(target, path) {
  const encoded = path
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/'/g, "%27"))
    .join("/")
    .replace(/^\//, "");
  return `vscode://vscode-remote/ssh-remote+${target}/${encoded}`;
}

export const outsideMethods = {
  // One lookup per app ID, done once: Spotlight knows apps wherever they're installed.
  findEditors(cx, extra = []) {
    if (window()?.platform === "windows") return;
    cx.spawn(async (cx) => {
      const found = [];
      for (const editor of [...EDITORS, ...extra]) {
        const r = await exec(
          "mdfind",
          [`kMDItemCFBundleIdentifier == '${String(editor.bundle).replace(/'/g, "")}'`],
          {},
        ).catch(() => null);
        if (r?.code === 0 && r.stdout.trim()) found.push(editor);
      }
      setShared(FOUND, found);
      cx.notify();
    });
  },

  // Show diff is only offered where XMux Changes can answer it.
  findChanges(cx) {
    cx.spawn(async (cx) => {
      const manifest = await readTextFile(`${appHome()}/mods/xmux-changes/mod.json`).catch(
        () => null,
      );
      setShared("xmux-files.has-changes", Boolean(manifest));
      cx.notify();
    });
  },

  findNewAgents(on, cx) {
    cx.spawn(async (cx) => {
      try {
        const known = await knownAgents({ on: on ?? null });
        setShared(
          "xmux-files.new-agents",
          known.filter((a) => a.installed).map((a) => ({ key: a.key, name: a.name, run: a.run })),
        );
      } catch {
        setShared("xmux-files.new-agents", []);
      }
      cx.notify();
    });
  },

  async outside(args, what) {
    const r = await exec("open", args, {}).catch((e) => ({ code: 1, stderr: String(e) }));
    if (r.code !== 0) setShared(ERROR, `Could not ${what}: ${r.stderr?.trim() || "it failed"}`);
    else setShared(ERROR, null);
  },

  async openRemoteVsCode(path, on) {
    try {
      const result = await hc(["machine", "ls", "--json"]);
      if (result.code !== 0) throw new Error(result.stderr || "Could not read Herdr machines.");
      const machine = JSON.parse(result.stdout).machines?.find((entry) => entry.name === on);
      if (!machine || machine.via || !machine.target) {
        throw new Error(`No SSH target is configured for ${on}.`);
      }
      await this.outside(
        ["-b", VSCODE, remoteVsCodeUri(machine.target, path)],
        `open ${on} in VS Code`,
      );
    } catch (error) {
      setShared(ERROR, `Could not open ${on} in VS Code: ${error.message}`);
    }
  },

  openInEditor(editor, path) {
    return this.outside(["-b", editor.bundle, path], `open it in ${editor.name}`);
  },

  openWithDefault(path) {
    return this.outside([path], "open it");
  },

  revealInFinder(path) {
    return this.outside(["-R", path], "show it in Finder");
  },
};

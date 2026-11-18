import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";

const home = process.argv[2];
if (!home) throw new Error("Usage: node scripts/configure-keys.mjs APP_HOME [BACKUP_DIR]");
const path = join(home, "keys.json");
let original;
try { original = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const keys = original === undefined ? {} : JSON.parse(original);
const section = keys["layout:XMux"] ??= {};
const mappings = {
  "cmd-t": ["xmux-status.new-terminal", "tab.new"],
  "cmd-d": ["xmux-status.split-right", "pane.split:right"],
  "cmd-shift-d": ["xmux-status.split-down", "pane.split:down"],
  "cmd-p": ["mod.open:xmux-picker", "mod.open:picker"],
  "cmd-ctrl-left": ["xmux-sidebar.show-spaces"],
  "cmd-ctrl-right": ["xmux-sidebar.show-agents"],
  "cmd-ctrl-up": ["xmux-status.cross-tab-prev"],
  "cmd-ctrl-down": ["xmux-status.cross-tab-next"],
  "cmd-ctrl-j": ["xmux-status.focus-attention"],
};
const directions = ["left", "right", "up", "down"];
for (const direction of directions) mappings[`cmd-shift-${direction}`] = [`pane.go:${direction}`];
let changed = false;
for (const [key, [action, builtin]] of Object.entries(mappings)) {
  const existing = section[key] ?? keys.global?.[key];
  if (existing === action) continue;
  if (existing !== undefined && existing !== builtin) {
    console.warn(`Kept personal XMux binding ${key}: ${existing}`);
    continue;
  }
  section[key] = action;
  changed = true;
}
for (const direction of directions) {
  const oldKey = `cmd-alt-${direction}`;
  const action = `pane.go:${direction}`;
  const newKey = `cmd-shift-${direction}`;
  if ((section[newKey] ?? keys.global?.[newKey]) !== action) continue;
  if ((section[oldKey] ?? keys.global?.[oldKey]) !== action) continue;
  // Suppress the former pane binding in XMux while preserving other layouts.
  section[oldKey] = "terminal";
  changed = true;
}
if (changed) {
  const backup = process.argv[3] ?? join(home, "retired", `xmux-keys-${Date.now()}`);
  if (original !== undefined) {
    await mkdir(backup, { recursive: true });
    await copyFile(path, join(backup, "keys.json"));
  }
  await mkdir(home, { recursive: true });
  // writeFile follows an existing Mackup/iCloud symlink.
  await writeFile(path, JSON.stringify(keys, null, 2) + "\n");
  console.log(`Configured XMux shortcuts. Backup at ${backup}`);
}

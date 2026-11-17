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
};
let changed = false;
for (const [key, [action, builtin]] of Object.entries(mappings)) {
  if (section[key] === action) continue;
  if (section[key] !== undefined && section[key] !== builtin) {
    console.warn(`Kept personal XMux binding ${key}: ${section[key]}`);
    continue;
  }
  section[key] = action;
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
  console.log(`Configured XMux terminal shortcuts; backup: ${backup}`);
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Herdr confines imports to each mod. Keep one source and materialize only the
// modules each mod uses; --check detects stale copies without rewriting them.
const root = new URL("../", import.meta.url);
const targets = {
  "provider.js": ["xmux-branch-pr", "xmux-branch-issue", "xmux-sidebar"],
  "hosting-cli.js": ["xmux-branch-pr", "xmux-branch-issue", "xmux-sidebar"],
  "merge-request.js": ["xmux-branch-pr", "xmux-sidebar"],
  "hosting.js": ["xmux-branch-pr", "xmux-branch-issue", "xmux-sidebar"],
  "context.js": ["xmux-status", "xmux-tabs", "xmux-sidebar", "xmux-new-menu", "xmux-changes", "xmux-branch-pr", "xmux-branch-issue"],
  "query-cache.js": ["xmux-changes", "xmux-branch-pr", "xmux-branch-issue", "xmux-sidebar"],
  "code-viewer.js": ["xmux-files", "xmux-changes"],
  "tab-title.js": ["xmux-tabs", "xmux-sidebar", "xmux-quick-dialog", "xmux-files", "xmux-picker"],
  "file-menu.js": ["xmux-files", "xmux-changes", "xmux-branch-pr"],
  "chat-menu.js": ["xmux-files", "xmux-branch-pr", "xmux-branch-issue"],
  "settings.js": ["xmux-tabs", "xmux-sidebar", "xmux-files", "xmux-changes", "xmux-branch-pr", "xmux-branch-issue"],
  "pr-settings.js": ["xmux-branch-pr", "xmux-sidebar"],
  "file-icons.js": ["xmux-files", "xmux-changes"],
  "file-tree.js": ["xmux-changes", "xmux-branch-pr"],
  "menu.js": ["xmux-files", "xmux-branch-pr", "xmux-branch-issue"],
};
for (const [file, mods] of Object.entries(targets)) {
  const source = new URL(`lib/xmux/${file}`, root);
  const content = `// Generated from lib/xmux/${file}. Run node scripts/sync-common.mjs.\n` + await readFile(source, "utf8");
  for (const mod of mods) {
    const dir = new URL(`mods/${mod}/shared/`, root);
    const target = new URL(file, dir);
    if (process.argv.includes("--check")) {
      if (await readFile(target, "utf8") !== content) throw new Error(`Stale shared module: ${fileURLToPath(target)}`);
    } else {
      await mkdir(dir, { recursive: true });
      await writeFile(target, content);
    }
  }
}

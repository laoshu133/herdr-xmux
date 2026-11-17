import { copyFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Herdr confines imports to each mod. Keep one source and materialize only the
// modules each mod uses; --check detects stale copies without rewriting them.
const root = new URL("../", import.meta.url);
const targets = {
  "provider.js": ["xmux-branch-pr", "xmux-branch-issue", "xmux-sidebar"],
  "merge-request.js": ["xmux-branch-pr", "xmux-sidebar"],
  "hosting.js": ["xmux-branch-pr", "xmux-sidebar"],
  "context.js": ["xmux-status", "xmux-tabs", "xmux-sidebar", "xmux-new-menu", "xmux-changes", "xmux-branch-pr", "xmux-branch-issue"],
  "query-cache.js": ["xmux-changes", "xmux-branch-pr", "xmux-branch-issue", "xmux-sidebar"],
  "code-viewer.js": ["xmux-files", "xmux-changes"],
  "tab-title.js": ["xmux-tabs", "xmux-sidebar"],
  "file-menu.js": ["xmux-files", "xmux-changes", "xmux-branch-pr"],
};
for (const [file, mods] of Object.entries(targets)) {
  const source = new URL(`lib/xmux/${file}`, root);
  const content = await readFile(source, "utf8");
  for (const mod of mods) {
    const dir = new URL(`mods/${mod}/shared/`, root);
    const target = new URL(file, dir);
    if (process.argv.includes("--check")) {
      if (await readFile(target, "utf8") !== content) throw new Error(`Stale shared module: ${fileURLToPath(target)}`);
    } else {
      await mkdir(dir, { recursive: true });
      await copyFile(source, target);
    }
  }
}

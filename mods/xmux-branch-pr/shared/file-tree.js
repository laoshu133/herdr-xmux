// Generated from lib/xmux/file-tree.js. Run node scripts/sync-common.mjs.
/** Build directory-first display rows, omitting descendants of closed folders. */
export function fileTree(files, pathOf, closed = new Set()) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = pathOf(file).split("/");
    parts.pop(); // The final component is the filename, not a directory.
    let node = root;
    let path = "";

    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      if (!node.dirs.has(part)) {
        node.dirs.set(part, { path, dirs: new Map(), files: [] });
      }
      node = node.dirs.get(part);
    }
    node.files.push(file);
  }

  const rows = [];
  function walk(node, depth) {
    const directories = [...node.dirs].sort(([a], [b]) => a.localeCompare(b));
    for (const [name, directory] of directories) {
      rows.push({ kind: "folder", name, path: directory.path, depth });
      if (!closed.has(directory.path)) walk(directory, depth + 1);
    }
    for (const file of node.files) {
      rows.push({ kind: "file", file, depth });
    }
  }

  walk(root, 0);
  return rows;
}

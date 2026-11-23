import { exec, hc, notify, readTextFile, spaces } from "herdr";
import { openFilePreview } from "./actions/open.js";
import { isImage, parentOf, viewable } from "./files/model.js";
import { MAX_IMAGE, mb, probeImage } from "./preview/images.js";
import { sshTarget } from "./preview/machines.js";

const PATH_TIMEOUT = 5000;
const DIAGNOSTIC_SUFFIX = /:\d+(?::\d+)?\.?$/;
const FILE_URI = /^file:(?:\/\/([^/]*))?(\/[^?#]*)(?:[?#].*)?$/i;

// Resolve relative paths and home directories on the machine that printed the link.
// The spelling is a positional argument. Never evaluate it as a shell expression.
const RESOLVE_PATH = [
  'p=$1',
  'case "$p" in',
  '  /*) ;;',
  '  "~/"*|\'$HOME/\'*) [ -n "$HOME" ] || exit 3; p="$HOME/${p#*/}";;',
  '  \'$PWD/\'*) [ -n "$2" ] || exit 3; p="${2%/}/${p#*/}";;',
  '  \'$\'*) exit 3;;',
  '  *) [ -n "$2" ] || exit 3; p="${2%/}/$p";;',
  'esac',
  '[ -e "$p" ] || exit 1',
  '[ -f "$p" ] && [ -r "$p" ] || exit 2',
  'dir=${p%/*}',
  'cd -P -- "${dir:-/}" && printf "%s/%s" "${PWD%/}" "${p##*/}"',
].join("\n");

function spelling(link, on) {
  const raw = link.raw;
  if (/^file:/i.test(raw)) {
    const parts = FILE_URI.exec(raw);
    if (!parts || (parts[1] && parts[1].toLowerCase() !== "localhost")) return null;
    return (!on && link.path) || decodeURIComponent(parts[2]);
  }
  return (!on && link.path) || raw.replace(/\.$/, "");
}

function passFile(link, on, problem) {
  // A remote file caught by a handler has no native opener, even after "pass".
  if (on || (!link.path && !/^file:/i.test(link.raw))) {
    const machine = on ? " on " + on : "";
    notify({ level: "warning", title: "XMux Files couldn’t preview this link", body: problem + machine + "." });
  }
  return "pass";
}

async function previewProblem(file) {
  if (!isImage(file.path)) return viewable(await readTextFile(file.path, { on: file.on })).problem;

  if (file.on) {
    const result = await hc(["machine", "ls", "--json"]);
    const target = sshTarget(result.stdout, file.on);
    if (target.error) return target.error;
  }
  const probe = await probeImage(exec, { ...file, timeout: PATH_TIMEOUT });
  if (probe.error) return probe.error;
  if (probe.size > MAX_IMAGE) return "Image exceeds the " + mb(MAX_IMAGE) + " MB preview limit";
}

export async function handleLink({ link, source }) {
  if (link?.kind !== "file" || typeof link.raw !== "string") return "pass";
  const on = source?.machine ?? null;
  if (DIAGNOSTIC_SUFFIX.test(link.raw) && !/^file:/i.test(link.raw)) {
    return on ? passFile(link, on, "Use an editor handler to open links with a line number") : "pass";
  }

  try {
    const candidate = spelling(link, on);
    // The exec bridge and preview loaders use POSIX paths.
    if (!candidate || /[\u0000\r\n\\]/.test(candidate) || /^\/?[a-z]:/i.test(candidate))
      return passFile(link, on, "This file link has an unsupported path");
    const space = spaces().find((entry) => entry.id === source?.space && (entry.machine ?? null) === on);
    if (!space) return passFile(link, on, "The source terminal has no Space available for a preview");

    const cwd = source.cwd?.startsWith("/") ? source.cwd : "";
    const result = await exec("sh", ["-c", RESOLVE_PATH, "link", candidate, cwd], { on, timeout: PATH_TIMEOUT });
    if (result.code === 1) return passFile(link, on, "File does not exist");
    if (result.code === 2) return passFile(link, on, "Path is not a readable regular file");
    if (result.code !== 0 || !result.stdout.startsWith("/"))
      return passFile(link, on, "Could not resolve the file path");
    const path = result.stdout;
    const folder = cwd.replace(/\/+$/, "");
    const root = cwd && path.startsWith(folder + "/") ? folder || "/" : parentOf(path);
    const file = { path, root, on };
    const problem = await previewProblem(file);
    if (problem) return passFile(link, on, problem);
    if (!spaces().some((entry) => entry.id === space.id && (entry.machine ?? null) === on))
      return passFile(link, on, "The source Space closed before the file could be opened");
    openFilePreview(file, space.id);
    return "handled";
  } catch (error) {
    return passFile(link, on, String(error?.message ?? error).split("\n")[0]);
  }
}

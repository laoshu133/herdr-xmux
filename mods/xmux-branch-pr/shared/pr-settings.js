// Generated from lib/xmux/pr-settings.js. Run node scripts/sync-common.mjs.
import { loadSettings } from "./settings.js";

export const PR_HOSTING_DEFAULTS = {
  tools: { github: "gh", gitlab: "glab" },
  hosts: [],
};

export function loadPRSettings(defaults = {}) {
  return loadSettings("xmux-branch-pr", { ...defaults, ...PR_HOSTING_DEFAULTS }, { localOverrides: true });
}

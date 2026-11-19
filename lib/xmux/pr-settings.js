import { loadSettings } from "./settings.js";

export const PR_HOSTING_DEFAULTS = {
  tools: { github: "gh", gitlab: "glab" },
  hosts: [],
};

export function loadPRSettings(defaults = {}) {
  return loadSettings("xmux-branch-pr", { ...defaults, ...PR_HOSTING_DEFAULTS }, { localOverrides: true });
}

import { agents, panes, run } from "herdr";
import { agentsOnIssue } from "../provider/model.js";

export const agentName = (agent) => agent?.tab_name || agent?.title || agent?.address || "agent";

export const agentMethods = {
  issueAgents() {
    if (!this.issue) return [];
    return agentsOnIssue({
      agents: agents(),
      panes: panes(),
      issue: this.issue,
      worktrees: this.currentWorktrees(),
      space: this.sp?.id,
    });
  },

  focusAgent(agent) {
    run("agent.focus", { terminal: agent.address });
  },
};

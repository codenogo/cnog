import chalk from "chalk";

import { buildStatusSnapshot } from "../status.js";
import { withDb, buildContext } from "./context.js";

export function statusCommand(opts: { json: boolean }): void {
  withDb((db) => {
    const ctx = buildContext(db);
    const snapshot = buildStatusSnapshot(ctx.db, ctx.config, ctx.watchdog);

    if (opts.json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }

    console.log(chalk.bold("cnog status"));
    console.log(`  Runtime: ${snapshot.summary.configuredRuntime}`);
    console.log(`  Active agents: ${snapshot.summary.activeAgents}`);
    console.log(`  Pending merges: ${snapshot.summary.pendingMerges}`);
    console.log(`  Merge conflicts: ${snapshot.summary.mergeConflicts}`);
    console.log(`  Unread mail: ${snapshot.summary.unreadMail}`);
    console.log(`  Tracked features: ${snapshot.summary.trackedFeatures}`);

    if (snapshot.agents.length > 0) {
      console.log("");
      console.log(chalk.bold("Agents"));
      for (const agent of snapshot.agents) {
        const health = agent.health === "healthy"
          ? ""
          : ` [${agent.health}${agent.healthReason ? `: ${agent.healthReason}` : ""}]`;
        console.log(`  ${agent.name} [${agent.runtime}/${agent.capability}] ${agent.state} — ${agent.feature ?? "-"}${health}`);
      }
    }

    if (snapshot.features.length > 0) {
      console.log("");
      console.log(chalk.bold("Features"));
      for (const feature of snapshot.features) {
        const verdict = feature.reviewVerdict ? ` (${feature.reviewVerdict})` : "";
        const profile = feature.profile ? ` [${feature.profile}]` : "";
        console.log(`  ${feature.feature}: ${feature.phase}${verdict}${profile}`);
      }
    }
  });
}

import type { Command } from "./base";
import { analytics } from "../analytics";
import { colors } from "../ui";

export const analyticsCommand: Command = {
  name: "analytics",
  aliases: ["stats"],
  description: "Show detailed tool analytics and performance metrics",
  async handler(_args, _messages) {
    const summary = analytics.getSummary();

    if (summary.totalCalls === 0) {
      return {
        type: "analytics",
        message: colors.dim("No tool calls recorded yet."),
      };
    }

    // Sort by most used
    const toolStats = Object.entries(summary.byTool)
      .sort((a, b) => b[1].calls - a[1].calls)
      .map(
        ([name, stats]) =>
          `  ${colors.tool(name.padEnd(20))} ${stats.calls}x | avg ${Math.round(stats.avgMs)}ms | ${Math.round(stats.errorRate * 100)}% err`
      )
      .join("\n");

    const totalErrors = Object.values(summary.byTool).reduce(
      (sum, s) => sum + Math.round(s.calls * s.errorRate),
      0
    );

    const avgTimePerCall = Object.values(summary.byTool).reduce(
      (sum, s) => sum + s.avgMs * s.calls,
      0
    ) / summary.totalCalls;

    const message = `
${colors.dim("Tool Analytics")}
  Total calls         : ${summary.totalCalls}
  Total errors        : ${totalErrors}
  Avg time per call   : ${Math.round(avgTimePerCall)}ms

${colors.dim("Tools by usage:")}
${toolStats}

${colors.dim("Session health:")}
  Success rate        : ${Math.round((1 - totalErrors / summary.totalCalls) * 100)}%
    `.trim();

    return {
      type: "analytics",
      message,
    };
  },
};

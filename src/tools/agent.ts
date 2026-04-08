import type { Tool, ToolContext, PermissionDecision, ToolResult } from "./base";
import type { GenericMessage } from "../providers/base";
import { streamResponse } from "../client";

export const agentTool: Tool = {
  name: "agent",
  description: `Launches a sub-agent to handle a complex, multi-step task autonomously.

Usage:
- Always include a short description (3-5 words) of what the agent will do in the task field.
- Launch multiple agents concurrently when tasks are independent.
- The agent result is not shown to the user directly — summarize the result in your response.
- Clearly tell the agent whether to write code or just do research.
- Agents have access to the same tools as the parent.
- Pass relevant context (paths, constraints, stack requirements) via the context field.
- Do not use agent for tasks that a single tool call can handle directly.`,
  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "The task for the sub-agent to handle",
      },
      context: {
        type: "string",
        description: "Optional context or constraints for the sub-agent",
      },
    },
    required: ["task"],
  },
  isReadOnly(): boolean {
    return false;
  },
  isDestructive(): boolean {
    return false;
  },
  isConcurrencySafe(): boolean {
    return false;
  },
  tags: ["agent", "orchestration"],
  async checkPermissions(
    input: Record<string, unknown>
  ): Promise<PermissionDecision> {
    const task = input.task as string;
    if (!task?.trim()) {
      return { allowed: false, reason: "Missing task argument" };
    }
    return { allowed: true };
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const task = input.task as string;
    const context = (input.context as string) || "";
    const agentId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const breadcrumbs = [
      ...(ctx.breadcrumbs ?? []),
      { agentId, task, timestamp: Date.now() },
    ];

    // Build initial message for sub-agent
    let userMessage = task;
    if (context) {
      userMessage = `Context: ${context}\n\nTask: ${task}`;
    }

    const subMessages: GenericMessage[] = [
      {
        role: "user",
        content: [
          userMessage,
          "",
          `Agent context: ${JSON.stringify({
            agentId,
            parentAgentId: ctx.agentId,
            breadcrumbs,
          })}`,
        ].join("\n"),
      },
    ];

    // Stream response from sub-agent
    let fullResponse = "";
    let currentToolCall: { name: string; input: Record<string, unknown> } | null =
      null;

    try {
      for await (const token of streamResponse(subMessages)) {
        // Parse tool invocations (in [TOOL:...] and [RESULT:...] format)
        if (token.startsWith("[TOOL:")) {
          const match = token.match(/\[TOOL:([^:]+):(.+)\]/);
          if (match && match.length > 2) {
            const name = match[1] || "";
            const inputStr = match[2] || "";
            try {
              currentToolCall = { name, input: JSON.parse(inputStr) };
            } catch {
              // Ignore parsing errors
            }
          }
          continue;
        }

        if (token.startsWith("[RESULT:")) {
          const result = token.substring("[RESULT:".length).replace(/\]$/, "");
          if (currentToolCall) {
            subMessages.push({
              role: "user",
              content: `Tool ${currentToolCall.name} returned: ${result}`,
            });
            currentToolCall = null;
          }
          continue;
        }

        // Accumulate response text
        fullResponse += token;
      }

      // Ensure final response is in message history
      if (fullResponse.trim()) {
        subMessages.push({
          role: "assistant",
          content: fullResponse,
        });
      }

      return {
        output: fullResponse.trim() || "(no output)",
        structuredData: { agentId, parentAgentId: ctx.agentId, breadcrumbs },
      };
    } catch (e) {
      return { output: `Error running sub-agent: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

import type { Tool, ToolContext, PermissionDecision } from "./base";
import type { GenericMessage } from "../providers/base";
import { streamResponse } from "../client";

export const agentTool: Tool = {
  name: "agent",
  description:
    "Spawn a sub-agent to handle a task independently with its own context and tool pool",
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
  async checkPermissions(
    input: Record<string, unknown>
  ): Promise<PermissionDecision> {
    const task = input.task as string;
    if (!task?.trim()) {
      return { allowed: false, reason: "Missing task argument" };
    }
    return { allowed: true };
  },
  async execute(input: Record<string, unknown>): Promise<string> {
    const task = input.task as string;
    const context = (input.context as string) || "";

    // Build initial message for sub-agent
    let userMessage = task;
    if (context) {
      userMessage = `Context: ${context}\n\nTask: ${task}`;
    }

    const subMessages: GenericMessage[] = [
      { role: "user", content: userMessage },
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

      return fullResponse.trim() || "(no output)";
    } catch (e) {
      return `Error running sub-agent: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

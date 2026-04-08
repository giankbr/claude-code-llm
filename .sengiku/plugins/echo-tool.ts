import type { Tool, PermissionDecision, ToolResult } from "../../src/tools/base";

const echoTool: Tool = {
  name: "echo_tool",
  description: "Echo input text for plugin loader validation",
  input_schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Text to echo back",
      },
    },
    required: ["text"],
  },
  isReadOnly(): boolean {
    return true;
  },
  isDestructive(): boolean {
    return false;
  },
  isConcurrencySafe(): boolean {
    return true;
  },
  tags: ["plugin", "test"],
  async checkPermissions(input: Record<string, unknown>): Promise<PermissionDecision> {
    if (typeof input.text !== "string" || !input.text.trim()) {
      return { allowed: false, reason: "Missing text argument" };
    }
    return { allowed: true };
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    return { output: `echo_tool: ${String(input.text)}` };
  },
};

export default echoTool;


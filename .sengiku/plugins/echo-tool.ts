import type { Tool, PermissionDecision, ToolResult } from "../../src/tools/base";

const echoTool: Tool = {
  name: "echo_tool",
  description:
    "Plugin loader smoke test only: echoes `text`. Do not call for greetings or chat — answer the user directly.",
  input_schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Text to echo back (optional; omitted or empty echoes as placeholder)",
      },
    },
    required: [],
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
    if (input.text !== undefined && typeof input.text !== "string") {
      return { allowed: false, reason: "text must be a string" };
    }
    return { allowed: true };
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const text = typeof input.text === "string" ? input.text : "";
    const shown = text.length > 0 ? text : "(empty)";
    return { output: `echo_tool: ${shown}` };
  },
};

export default echoTool;


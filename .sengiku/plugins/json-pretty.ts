import type { Tool, PermissionDecision, ToolResult } from "../../src/tools/base";

const jsonPrettyTool: Tool = {
  name: "json_pretty",
  description: "Validate and pretty-print JSON text",
  input_schema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Raw JSON string to validate and format",
      },
      indent: {
        type: "number",
        description: "Indent width (default 2, max 8)",
      },
    },
    required: ["content"],
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
  tags: ["plugin", "json", "utility"],
  async checkPermissions(input: Record<string, unknown>): Promise<PermissionDecision> {
    if (typeof input.content !== "string" || !input.content.trim()) {
      return { allowed: false, reason: "Missing content argument" };
    }
    return { allowed: true };
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const raw = String(input.content);
    const indentRaw = typeof input.indent === "number" ? input.indent : 2;
    const indent = Math.max(0, Math.min(8, Math.floor(indentRaw)));
    try {
      const parsed = JSON.parse(raw) as unknown;
      return {
        output: JSON.stringify(parsed, null, indent),
        format: "json",
      };
    } catch (error) {
      return {
        output: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export default jsonPrettyTool;


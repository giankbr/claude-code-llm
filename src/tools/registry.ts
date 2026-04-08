import type { Tool, ToolContext } from "./base";
import type { GenericTool } from "../providers/base";
import { readFileTool } from "./read-file";
import { writeFileTool } from "./write-file";
import { bashTool } from "./bash";
import { listDirTool } from "./list-dir";
import { searchFilesTool } from "./search-files";
import { editFileTool } from "./edit-file";
import { agentTool } from "./agent";
import { resolvePermission } from "../permissions";

const toolInstances: Tool[] = [
  readFileTool,
  writeFileTool,
  bashTool,
  listDirTool,
  searchFilesTool,
  editFileTool,
  agentTool,
];

// Convert Tool objects to GenericTool for provider compatibility
export const TOOLS: GenericTool[] = toolInstances.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}));

export function getTool(name: string): Tool | undefined {
  return toolInstances.find((t) => t.name === name);
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext = { workspaceRoot: process.cwd(), permissionMode: "default" }
): Promise<string> {
  const tool = getTool(name);
  if (!tool) {
    return `Unknown tool: ${name}`;
  }

  // Check tool-level permissions (sandbox checks)
  const toolPermission = await tool.checkPermissions(input, ctx);
  if (!toolPermission.allowed) {
    return `Permission denied: ${toolPermission.reason || "unknown reason"}`;
  }

  // Check mode-based permissions (user confirmation for destructive)
  const modePermission = await resolvePermission(
    {
      toolName: name,
      isReadOnly: tool.isReadOnly(),
      isDestructive: tool.isDestructive(),
    },
    ctx.permissionMode
  );
  if (!modePermission) {
    return `Tool execution cancelled by user`;
  }

  // Execute tool
  return tool.execute(input, ctx);
}

export type { Tool, ToolContext, PermissionMode } from "./base";

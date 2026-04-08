import path from "node:path";
import { promises as fs } from "node:fs";
import type { Tool, ToolContext, PermissionDecision } from "./base";

const WORKSPACE_ROOT = process.cwd();

function resolveInWorkspace(inputPath: string): string | null {
  const resolved = path.resolve(WORKSPACE_ROOT, inputPath);
  const relative = path.relative(WORKSPACE_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

export const listDirTool: Tool = {
  name: "list_dir",
  description: "List files and directories in a folder",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The path to the directory to list (defaults to current)",
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
  async checkPermissions(
    input: Record<string, unknown>
  ): Promise<PermissionDecision> {
    const inputPath = (input.path as string) || ".";
    const safePath = resolveInWorkspace(inputPath);
    if (!safePath) {
      return { allowed: false, reason: "Path outside workspace" };
    }
    return { allowed: true };
  },
  async execute(input: Record<string, unknown>): Promise<string> {
    const inputPath = (input.path as string) || ".";
    const safePath = resolveInWorkspace(inputPath);
    if (!safePath) {
      return "Error: path outside workspace";
    }
    try {
      const entries = await fs.readdir(safePath, { withFileTypes: true });
      const lines = entries.map((entry) => {
        const type = entry.isDirectory() ? "/" : "";
        return `  ${entry.name}${type}`;
      });
      return `${safePath}\n${lines.join("\n")}`;
    } catch (e) {
      return `Error listing directory: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

import path from "node:path";
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

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Write content to a file (overwrites if exists)",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The path to the file to write",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["path", "content"],
  },
  isReadOnly(): boolean {
    return false;
  },
  isDestructive(): boolean {
    return true;
  },
  async checkPermissions(
    input: Record<string, unknown>
  ): Promise<PermissionDecision> {
    const inputPath = input.path as string;
    if (!inputPath?.trim()) {
      return { allowed: false, reason: "Missing path argument" };
    }
    const safePath = resolveInWorkspace(inputPath);
    if (!safePath) {
      return { allowed: false, reason: "Path outside workspace" };
    }
    return { allowed: true };
  },
  async execute(input: Record<string, unknown>): Promise<string> {
    const inputPath = input.path as string;
    const content = input.content as string;
    const safePath = resolveInWorkspace(inputPath);
    if (!safePath) {
      return `Error writing file: path outside workspace`;
    }
    try {
      await Bun.write(safePath, content);
      return `Successfully wrote to ${safePath}`;
    } catch (e) {
      return `Error writing file: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

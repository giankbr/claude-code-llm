import path from "node:path";
import type { Tool, PermissionDecision, ToolResult } from "./base";

const WORKSPACE_ROOT = process.cwd();

function resolveInWorkspace(inputPath: string): string | null {
  const resolved = path.resolve(WORKSPACE_ROOT, inputPath);
  const relative = path.relative(WORKSPACE_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

export const readFileTool: Tool = {
  name: "read_file",
  description: `Reads the full contents of a file from the workspace.

Usage:
- Use this instead of bash cat/head/tail commands.
- Must be called at least once before editing a file with edit_file.
- Returns raw file contents with line numbers for reference.
- Only reads files within the workspace root (path traversal blocked).`,
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The path to the file to read",
      },
    },
    required: ["path"],
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
  maxResultSizeChars: 60_000,
  tags: ["file", "read-only"],
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
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = input.path as string;
    const safePath = resolveInWorkspace(inputPath);
    if (!safePath) {
      return { output: "Error reading file: path outside workspace" };
    }
    try {
      const file = Bun.file(safePath);
      const content = await file.text();
      return { output: content, format: "text" };
    } catch (e) {
      return { output: `Error reading file: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

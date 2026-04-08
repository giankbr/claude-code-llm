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

export const writeFileTool: Tool = {
  name: "write_file",
  description: `Creates or overwrites a file with the given content.

Usage:
- ALWAYS prefer editing existing files (use edit_file) over writing new ones unless explicitly required.
- When creating a new file, first use list_dir to verify the target directory exists.
- Never generate binary content or long non-textual content.
- Do not add comments that merely narrate what the code does.`,
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
  isConcurrencySafe(): boolean {
    return false;
  },
  tags: ["file", "write", "destructive"],
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
    const content = input.content as string;
    const safePath = resolveInWorkspace(inputPath);
    if (!safePath) {
      return { output: "Error writing file: path outside workspace" };
    }
    try {
      await Bun.write(safePath, content);
      return { output: `Successfully wrote to ${safePath}` };
    } catch (e) {
      return { output: `Error writing file: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

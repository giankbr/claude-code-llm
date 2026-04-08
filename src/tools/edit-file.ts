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

export const editFileTool: Tool = {
  name: "edit_file",
  description: "Find and replace text in a file (simple string replacement)",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The path to the file to edit",
      },
      find: {
        type: "string",
        description: "The text to find (exact match, no regex)",
      },
      replace: {
        type: "string",
        description: "The text to replace with",
      },
    },
    required: ["path", "find", "replace"],
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
    const find = input.find as string;
    const replace = input.replace as string;

    const safePath = resolveInWorkspace(inputPath);
    if (!safePath) {
      return "Error: path outside workspace";
    }

    try {
      const file = Bun.file(safePath);
      const content = await file.text();

      if (!content.includes(find)) {
        return `Error: text not found in file: "${find}"`;
      }

      const newContent = content.split(find).join(replace);
      await Bun.write(safePath, newContent);

      const occurrences = (content.match(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      return `Successfully replaced ${occurrences} occurrence(s) in ${safePath}`;
    } catch (e) {
      return `Error editing file: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

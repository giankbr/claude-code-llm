import path from "node:path";
import { promises as fs } from "node:fs";
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

async function findFilesRecursive(
  dir: string,
  pattern: RegExp,
  maxFiles: number = 50
): Promise<string[]> {
  const results: string[] = [];

  async function search(currentDir: string): Promise<void> {
    if (results.length >= maxFiles) return;

    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxFiles) return;

        const fullPath = path.join(currentDir, entry.name);
        const relative = path.relative(WORKSPACE_ROOT, fullPath);

        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && !entry.name.includes("node_modules")) {
            await search(fullPath);
          }
        } else if (pattern.test(entry.name)) {
          results.push(relative);
        }
      }
    } catch {
      // skip inaccessible directories
    }
  }

  await search(dir);
  return results;
}

export const searchFilesTool: Tool = {
  name: "search_files",
  description: `Searches for files by name pattern (regex) in the workspace.

Usage:
- Use this instead of bash find or ls commands for file discovery.
- Pattern is a regex matched against file names (e.g. '.*\\.ts$').
- Use start_path to narrow scope to a subdirectory.
- Skips hidden directories and node_modules automatically.
- Returns up to 50 matching relative paths.`,
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to match file names (e.g., '.*\\.ts$')",
      },
      start_path: {
        type: "string",
        description: "Directory to start search from (defaults to root)",
      },
    },
    required: ["pattern"],
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
  maxResultSizeChars: 30_000,
  tags: ["file", "search", "read-only"],
  async checkPermissions(
    input: Record<string, unknown>
  ): Promise<PermissionDecision> {
    const pattern = input.pattern as string;
    if (!pattern?.trim()) {
      return { allowed: false, reason: "Missing pattern argument" };
    }
    if (pattern.length > 200) {
      return { allowed: false, reason: "Pattern too long; keep regex under 200 chars" };
    }
    const startPath = (input.start_path as string) || ".";
    const safePath = resolveInWorkspace(startPath);
    if (!safePath) {
      return { allowed: false, reason: "start_path outside workspace" };
    }
    return { allowed: true };
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const startPath = (input.start_path as string) || ".";

    const safePath = resolveInWorkspace(startPath);
    if (!safePath) {
      return { output: "Error: start_path outside workspace" };
    }

    try {
      const regex = new RegExp(pattern);
      const results = await findFilesRecursive(safePath, regex);

      if (results.length === 0) {
        return {
          output: `No files matching pattern: ${pattern}`,
          format: "json",
          structuredData: { matches: [], pattern },
        };
      }

      return {
        output: results.join("\n"),
        format: "json",
        structuredData: { matches: results, pattern },
      };
    } catch (e) {
      return { output: `Error searching files: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

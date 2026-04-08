import path from "node:path";
import type { Tool, PermissionDecision, ToolResult } from "./base";

const WORKSPACE_ROOT = process.cwd();

const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+-rf\s+\//,
  /\brm\s+-rf\s+\.\b/,
  /\bmkfs\b/,
  /\bdd\s+if=.*\sof=\/dev\//,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bpoweroff\b/,
];

const DISALLOWED_UTILITY_PATTERNS = [
  /\bfind\b/,
  /\bgrep\b/,
  /\bcat\b/,
  /\bhead\b/,
  /\btail\b/,
  /\bsed\b/,
  /\bawk\b/,
  /\becho\b/,
];

function isDangerousCommand(command: string): boolean {
  const normalized = command.toLowerCase().trim();
  return DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function usesDisallowedUtility(command: string): boolean {
  return DISALLOWED_UTILITY_PATTERNS.some((pattern) => pattern.test(command));
}

function hasAbsolutePathOutsideWorkspace(command: string): boolean {
  const matches = command.match(/(^|[\s"'`])\/[^\s"'`|;&]*/g) ?? [];
  for (const raw of matches) {
    const absolutePath = raw.trim().replace(/^["'`]/, "");
    const relative = path.relative(WORKSPACE_ROOT, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return true;
    }
  }
  return false;
}

export const bashTool: Tool = {
  name: "bash",
  description: `Executes a given bash command and returns its output.

The working directory persists between commands, but shell state does not.

IMPORTANT: Avoid using this tool to run find, grep, cat, head, tail, sed, awk, or echo unless explicitly instructed or after verifying no dedicated tool can accomplish the task. Instead:
- File search: use search_files (NOT find/ls)
- Read files: use read_file (NOT cat/head/tail)
- Edit files: use edit_file (NOT sed/awk)
- Write files: use write_file (NOT echo/cat EOF)

Instructions:
- Before creating new directories/files, use list_dir to verify parent exists.
- Always quote file paths containing spaces with double quotes.
- Prefer absolute paths; avoid cd to change directories.
- Chain dependent commands with &&. Issue independent commands in separate calls.
- For git: prefer new commits over amending. Never skip hooks unless asked.
- Avoid unnecessary sleep commands.
- Commands timeout after 120000ms (2 min) by default.`,
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command to run",
      },
    },
    required: ["command"],
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
  maxResultSizeChars: 40_000,
  tags: ["shell", "destructive"],
  async checkPermissions(
    input: Record<string, unknown>
  ): Promise<PermissionDecision> {
    const command = input.command as string;
    if (!command?.trim()) {
      return { allowed: false, reason: "Missing command argument" };
    }

    if (isDangerousCommand(command)) {
      return {
        allowed: false,
        reason: `Blocked potentially destructive command: ${command}`,
      };
    }

    if (usesDisallowedUtility(command)) {
      return {
        allowed: false,
        reason: "Blocked disallowed shell utility. Use dedicated tools instead.",
      };
    }

    if (hasAbsolutePathOutsideWorkspace(command)) {
      return {
        allowed: false,
        reason: "Blocked command with absolute path outside workspace",
      };
    }

    return { allowed: true };
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const command = input.command as string;
    try {
      const proc = Bun.spawnSync(["bash", "-c", command], {
        cwd: WORKSPACE_ROOT,
      });
      const stdout = new TextDecoder().decode(proc.stdout);
      const stderr = new TextDecoder().decode(proc.stderr);
      const output = stdout + (stderr ? "\n[stderr]\n" + stderr : "");
      return { output: output.trim() || "(no output)" };
    } catch (e) {
      return { output: `Error running command: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

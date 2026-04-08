import path from "node:path";
import type { Tool, ToolContext, PermissionDecision } from "./base";

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

function isDangerousCommand(command: string): boolean {
  const normalized = command.toLowerCase().trim();
  return DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(normalized));
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
  description: "Run a bash command and return stdout + stderr",
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

    if (hasAbsolutePathOutsideWorkspace(command)) {
      return {
        allowed: false,
        reason: "Blocked command with absolute path outside workspace",
      };
    }

    return { allowed: true };
  },
  async execute(input: Record<string, unknown>): Promise<string> {
    const command = input.command as string;
    try {
      const proc = Bun.spawnSync(["bash", "-c", command], {
        cwd: WORKSPACE_ROOT,
      });
      const stdout = new TextDecoder().decode(proc.stdout);
      const stderr = new TextDecoder().decode(proc.stderr);
      const output = stdout + (stderr ? "\n[stderr]\n" + stderr : "");
      return output.trim() || "(no output)";
    } catch (e) {
      return `Error running command: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

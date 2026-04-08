import type { GenericTool } from "./providers/base";
import path from "node:path";

const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+-rf\s+\//,
  /\brm\s+-rf\s+\.\b/,
  /\bmkfs\b/,
  /\bdd\s+if=.*\sof=\/dev\//,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bpoweroff\b/,
];

const WORKSPACE_ROOT = process.cwd();

function isDangerousCommand(command: string): boolean {
  const normalized = command.toLowerCase().trim();
  return DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function resolveInWorkspace(inputPath: string): string | null {
  const resolved = path.resolve(WORKSPACE_ROOT, inputPath);
  const relative = path.relative(WORKSPACE_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
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

export const TOOLS: GenericTool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "The path to the file to read",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file (overwrites if exists)",
    input_schema: {
      type: "object" as const,
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
  },
  {
    name: "bash",
    description: "Run a bash command and return stdout + stderr",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The bash command to run",
        },
      },
      required: ["command"],
    },
  },
];

export async function executeTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "read_file": {
      const inputPath = input.path as string;
      if (!inputPath?.trim()) {
        return "Error reading file: missing `path` argument";
      }
      const safePath = resolveInWorkspace(inputPath);
      if (!safePath) {
        return `Blocked path outside workspace: ${inputPath}`;
      }
      try {
        const file = Bun.file(safePath);
        const content = await file.text();
        return content;
      } catch (e) {
        return `Error reading file: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    case "write_file": {
      const inputPath = input.path as string;
      const content = input.content as string;
      if (!inputPath?.trim()) {
        return "Error writing file: missing `path` argument";
      }
      const safePath = resolveInWorkspace(inputPath);
      if (!safePath) {
        return `Blocked path outside workspace: ${inputPath}`;
      }
      try {
        await Bun.write(safePath, content);
        return `Successfully wrote to ${safePath}`;
      } catch (e) {
        return `Error writing file: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    case "bash": {
      const command = input.command as string;
      if (!command?.trim()) {
        return "Error running command: missing `command` argument";
      }

      if (isDangerousCommand(command)) {
        return `Blocked potentially destructive command: ${command}`;
      }
      if (hasAbsolutePathOutsideWorkspace(command)) {
        return `Blocked command with absolute path outside workspace: ${command}`;
      }

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
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

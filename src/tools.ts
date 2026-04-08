import type { GenericTool } from "./providers/base";

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
      const path = input.path as string;
      try {
        const file = Bun.file(path);
        const content = await file.text();
        return content;
      } catch (e) {
        return `Error reading file: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    case "write_file": {
      const path = input.path as string;
      const content = input.content as string;
      try {
        await Bun.write(path, content);
        return `Successfully wrote to ${path}`;
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

      try {
        const proc = Bun.spawnSync(["bash", "-c", command]);
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

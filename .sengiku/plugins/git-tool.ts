import type { Tool, PermissionDecision, ToolResult, ToolContext } from "../../src/tools/base";

type GitAction =
  | "status"
  | "diff"
  | "log"
  | "branch"
  | "add"
  | "commit"
  | "push";

function parseAction(input: Record<string, unknown>): GitAction | null {
  const action = input.action;
  if (
    action === "status" ||
    action === "diff" ||
    action === "log" ||
    action === "branch" ||
    action === "add" ||
    action === "commit" ||
    action === "push"
  ) {
    return action;
  }
  return null;
}

function shellEscapeSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function buildCommand(input: Record<string, unknown>, action: GitAction): string | null {
  if (action === "status") return "git status --short --branch";
  if (action === "diff") return "git diff";
  if (action === "branch") return "git branch --all";

  if (action === "log") {
    const limitRaw = Number(input.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(30, Math.floor(limitRaw)) : 10;
    return `git log --oneline -n ${limit}`;
  }

  if (action === "add") {
    const addAll = input.add_all === true;
    const paths = Array.isArray(input.paths)
      ? input.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    if (addAll) {
      return "git add .";
    }
    if (paths.length === 0) {
      return null;
    }
    const joined = paths.map((p) => `'${shellEscapeSingleQuote(p)}'`).join(" ");
    return `git add ${joined}`;
  }

  if (action === "commit") {
    const message =
      typeof input.message === "string" ? input.message.trim() : "";
    if (!message) {
      return null;
    }
    const escaped = shellEscapeSingleQuote(message);
    return `git commit -m '${escaped}'`;
  }

  if (action === "push") {
    const remote =
      typeof input.remote === "string" && input.remote.trim() ? input.remote.trim() : "origin";
    const branch =
      typeof input.branch === "string" && input.branch.trim() ? input.branch.trim() : "";
    if (!branch) {
      return null;
    }
    return `git push ${remote} ${branch}`;
  }

  return null;
}

function isMutatingAction(action: GitAction): boolean {
  return action === "add" || action === "commit" || action === "push";
}

const gitTool: Tool = {
  name: "git_tool",
  description:
    "Git helper for status/diff/log/branch and guarded add/commit/push operations.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "One of: status, diff, log, branch, add, commit, push",
      },
      limit: {
        type: "number",
        description: "Optional max commit lines for log action (default 10, max 30)",
      },
      add_all: {
        type: "boolean",
        description: "For add action: true to run git add .",
      },
      paths: {
        type: "array",
        description: "For add action: list of file paths to stage",
      },
      message: {
        type: "string",
        description: "For commit action: commit message",
      },
      remote: {
        type: "string",
        description: "For push action: remote name (default origin)",
      },
      branch: {
        type: "string",
        description: "For push action: branch name to push",
      },
      confirm: {
        type: "boolean",
        description: "Must be true for mutating actions: add, commit, push",
      },
    },
    required: ["action"],
  },
  isReadOnly(): boolean {
    return false;
  },
  isDestructive(): boolean {
    return true;
  },
  isConcurrencySafe(): boolean {
    return true;
  },
  tags: ["git", "read-only", "plugin"],
  async checkPermissions(
    input: Record<string, unknown>,
    _ctx: ToolContext
  ): Promise<PermissionDecision> {
    const action = parseAction(input);
    if (!action) {
      return {
        allowed: false,
        reason: "Invalid action. Use status, diff, log, branch, add, commit, or push.",
      };
    }

    if (isMutatingAction(action) && input.confirm !== true) {
      return {
        allowed: false,
        reason: "Mutating git actions require confirm=true.",
      };
    }

    if (action === "commit") {
      const msg = typeof input.message === "string" ? input.message.trim() : "";
      if (!msg) {
        return { allowed: false, reason: "Commit action requires non-empty message." };
      }
    }

    if (action === "add") {
      const addAll = input.add_all === true;
      const paths = Array.isArray(input.paths) ? input.paths : [];
      if (!addAll && paths.length === 0) {
        return {
          allowed: false,
          reason: "Add action requires add_all=true or non-empty paths array.",
        };
      }
    }

    if (action === "push") {
      const branch = typeof input.branch === "string" ? input.branch.trim() : "";
      if (!branch) {
        return { allowed: false, reason: "Push action requires branch." };
      }
    }

    return { allowed: true };
  },
  async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const action = parseAction(input);
    if (!action) {
      return { output: "Invalid action. Use status, diff, log, branch, add, commit, or push." };
    }
    const command = buildCommand(input, action);
    if (!command) {
      return { output: `git_tool invalid input for action: ${action}` };
    }
    try {
      const proc = Bun.spawnSync(["bash", "-lc", command], { cwd: process.cwd() });
      const stdout = new TextDecoder().decode(proc.stdout).trim();
      const stderr = new TextDecoder().decode(proc.stderr).trim();
      if (proc.exitCode !== 0) {
        return { output: `git_tool failed (${action}): ${stderr || "unknown error"}` };
      }
      return { output: stdout || "(no output)" };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { output: `git_tool error: ${msg}` };
    }
  },
};

export default gitTool;

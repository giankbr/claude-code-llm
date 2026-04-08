import type { Tool } from "./tools/base";

const DISALLOWED_BASH_PATTERNS = [
  /\bfind\b/,
  /\bgrep\b/,
  /\bcat\b/,
  /\bhead\b/,
  /\btail\b/,
  /\bsed\b/,
  /\bawk\b/,
  /\becho\b/,
];

function isExplicitlyAllowedShellPattern(command: string): boolean {
  return /explicitly required|explicitly instructed/i.test(command);
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

export function evaluatePolicy(
  tool: Tool,
  input: Record<string, unknown>,
  role: "default" | "auto" | "plan" | "bypassPermissions"
): PolicyDecision {
  if (role === "plan" && !tool.isReadOnly()) {
    return {
      allowed: false,
      reason: "Plan mode allows read-only tools only.",
    };
  }

  if (tool.name === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (!command.trim()) {
      return { allowed: false, reason: "Policy blocked: missing bash command input." };
    }
    if (
      DISALLOWED_BASH_PATTERNS.some((pattern) => pattern.test(command)) &&
      !isExplicitlyAllowedShellPattern(command)
    ) {
      return {
        allowed: false,
        reason:
          "Policy blocked: bash command uses a disallowed utility. Use dedicated tools instead.",
      };
    }
  }

  if (tool.name === "search_files") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    if (!pattern || pattern.length > 200) {
      return { allowed: false, reason: "Policy blocked: invalid search_files pattern." };
    }
  }

  return { allowed: true };
}


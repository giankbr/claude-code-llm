import inquirer from "inquirer";
import type { PermissionMode } from "./tools/base";

export interface PermissionRequest {
  toolName: string;
  isReadOnly: boolean;
  isDestructive: boolean;
  reason?: string;
}

/**
 * Resolve tool permission based on mode and tool properties.
 * Flow:
 * 1. Read-only tools always allowed
 * 2. Check always-allow rules (env config)
 * 3. Check always-deny rules (blocked patterns)
 * 4. Destructive + default mode -> ask user
 * 5. Auto mode -> auto-approve
 * 6. Bypass mode -> auto-approve
 */
export async function resolvePermission(
  request: PermissionRequest,
  mode: PermissionMode
): Promise<boolean> {
  // 1. Read-only tools always allowed
  if (request.isReadOnly) {
    return true;
  }

  // 2. Check always-allow rules
  const alwaysAllow = (process.env.ALWAYS_ALLOW || "").split(",").map((s) => s.trim());
  if (alwaysAllow.includes(request.toolName)) {
    return true;
  }

  // 3. Check always-deny rules (for dangerous patterns, handled in tool.checkPermissions)
  // This is already done at the tool level

  // 4. Destructive + default mode -> ask user
  if (request.isDestructive && mode === "default") {
    const { confirmed } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmed",
        message: `Allow destructive tool "${request.toolName}"?`,
        default: false,
      },
    ]);
    return confirmed;
  }

  // 5. Auto mode -> auto-approve
  if (mode === "auto") {
    return true;
  }

  // 6. Bypass mode -> auto-approve
  if (mode === "bypassPermissions") {
    return true;
  }

  // Default: allow (shouldn't reach here)
  return true;
}

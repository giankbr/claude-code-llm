import inquirer from "inquirer";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PermissionMode, UserRole } from "./tools/base";

export interface PermissionRequest {
  toolName: string;
  isReadOnly: boolean;
  isDestructive: boolean;
  reason?: string;
  command?: string;
}

export interface ToolPermissionOverride {
  toolName: string;
  mode: PermissionMode;
  allowedRoles?: UserRole[];
}

interface PermissionsConfig {
  role?: UserRole;
  toolOverrides?: ToolPermissionOverride[];
}

const PERMISSIONS_FILE = path.join(process.cwd(), ".sengiku", "permissions.json");

function loadPermissionsConfig(): PermissionsConfig {
  if (!existsSync(PERMISSIONS_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(PERMISSIONS_FILE, "utf8")) as PermissionsConfig;
  } catch {
    return {};
  }
}

function getEffectiveMode(
  toolName: string,
  defaultMode: PermissionMode,
  overrides: ToolPermissionOverride[]
): PermissionMode {
  const match = overrides.find((override) => override.toolName === toolName);
  return match?.mode ?? defaultMode;
}

function isDangerousAutoCommand(command?: string): boolean {
  if (!command) {
    return false;
  }
  return /\brm\s+-rf\b|\bmkfs\b|\bdd\s+if=.*\sof=\/dev\//i.test(command);
}

function roleAllowsTool(
  request: PermissionRequest,
  role: UserRole,
  toolOverride?: ToolPermissionOverride
): boolean {
  if (toolOverride?.allowedRoles && !toolOverride.allowedRoles.includes(role)) {
    return false;
  }

  if (role === "admin") {
    return true;
  }

  if (role === "viewer") {
    return request.isReadOnly;
  }

  // editor
  return !request.isDestructive;
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
  const cfg = loadPermissionsConfig();
  const role = cfg.role ?? "admin";
  const overrides = cfg.toolOverrides ?? [];
  const toolOverride = overrides.find((override) => override.toolName === request.toolName);
  const effectiveMode = getEffectiveMode(request.toolName, mode, overrides);

  // 1) Always allow from env
  const alwaysAllow = (process.env.ALWAYS_ALLOW || "").split(",").map((s) => s.trim());
  if (alwaysAllow.includes(request.toolName)) {
    return true;
  }

  // 2) Role-based gate
  if (!roleAllowsTool(request, role, toolOverride)) {
    return false;
  }

  // 3) Plan mode asks always
  if (effectiveMode === "plan") {
    const { confirmed } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmed",
        message: `Allow tool "${request.toolName}" in plan mode?`,
        default: false,
      },
    ]);
    return confirmed;
  }

  // 4) Bypass permissions
  if (effectiveMode === "bypassPermissions") {
    return true;
  }

  // 5) Auto mode with smart warnings for dangerous commands
  if (effectiveMode === "auto") {
    if (!isDangerousAutoCommand(request.command)) {
      return true;
    }
    const { confirmed } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmed",
        message: `Command for "${request.toolName}" looks dangerous. Continue?`,
        default: false,
      },
    ]);
    return confirmed;
  }

  // 6) Default mode: ask only destructive tools
  if (request.isReadOnly) {
    return true;
  }
  if (request.isDestructive) {
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

  return true;
}

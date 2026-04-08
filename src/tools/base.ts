export type PermissionMode = "default" | "auto" | "bypassPermissions";

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

export interface ToolContext {
  workspaceRoot: string;
  permissionMode: PermissionMode;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  isReadOnly(): boolean;
  isDestructive(): boolean;
  checkPermissions(
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<PermissionDecision>;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

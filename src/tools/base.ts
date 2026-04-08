export type PermissionMode = "default" | "auto" | "plan" | "bypassPermissions";
export type UserRole = "viewer" | "editor" | "admin";

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

export interface AgentBreadcrumb {
  agentId: string;
  task: string;
  timestamp: number;
}

export interface ToolResult {
  output: string;
  structuredData?: Record<string, unknown>;
  truncated?: boolean;
  cached?: boolean;
  format?: "text" | "json" | "table";
}

export interface ToolContext {
  workspaceRoot: string;
  permissionMode: PermissionMode;
  correlationId?: string;
  agentId?: string;
  parentAgentId?: string;
  breadcrumbs?: AgentBreadcrumb[];
  role?: UserRole;
  sessionId?: string;
  signal?: AbortSignal;
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
  isConcurrencySafe(): boolean;
  maxResultSizeChars?: number;
  dependencies?: string[];
  version?: string;
  tags?: string[];
  checkPermissions(
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<PermissionDecision>;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  executeStreaming?(
    input: Record<string, unknown>,
    ctx: ToolContext,
    onProgress: (msg: string) => void
  ): AsyncGenerator<string>;
  onBeforeExecute?(input: Record<string, unknown>, ctx: ToolContext): Promise<void>;
  onAfterExecute?(result: ToolResult, ctx: ToolContext): Promise<void>;
  onError?(error: Error, ctx: ToolContext): Promise<ToolResult | null>;
}

import type { Tool, ToolContext, ToolResult } from "./base";
import type { GenericTool } from "../providers/base";
import { readFileTool } from "./read-file";
import { writeFileTool } from "./write-file";
import { bashTool } from "./bash";
import { listDirTool } from "./list-dir";
import { searchFilesTool } from "./search-files";
import { editFileTool } from "./edit-file";
import { agentTool } from "./agent";
import { resolvePermission } from "../permissions";
import { analytics } from "../analytics";
import { loadPluginTools } from "./loader";
import path from "node:path";

export class ToolPermissionError extends Error {}
export class ToolValidationError extends Error {}
export class ToolExecutionError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean = false
  ) {
    super(message);
  }
}

interface RetryConfig {
  maxAttempts: number;
  backoffMs: number;
}

const RETRYABLE_TOOLS = new Set(["bash", "search_files", "agent"]);
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  backoffMs: 500,
};

const FALLBACK_MAP: Record<string, string> = {
  search_files: "bash",
};

class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }
}

export const registry = new ToolRegistry();
const builtInTools: Tool[] = [
  readFileTool,
  writeFileTool,
  bashTool,
  listDirTool,
  searchFilesTool,
  editFileTool,
  agentTool,
];
builtInTools.forEach((tool) => registry.register(tool));
let initialized = false;

export async function initializeTools(): Promise<void> {
  if (initialized) {
    return;
  }
  initialized = true;
  const pluginDir = path.join(process.cwd(), ".sengiku", "plugins");
  const plugins = await loadPluginTools(pluginDir);
  for (const plugin of plugins) {
    registry.register(plugin);
  }
}

// Convert Tool objects to GenericTool for provider compatibility
export function getGenericTools(): GenericTool[] {
  return registry.getAll().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

function clampResult(tool: Tool, result: ToolResult): ToolResult {
  if (!tool.maxResultSizeChars || result.output.length <= tool.maxResultSizeChars) {
    return result;
  }
  return {
    ...result,
    output: `${result.output.slice(0, tool.maxResultSizeChars)}\n...[truncated]`,
    truncated: true,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runToolWithRetry(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolContext,
  retryConfig: RetryConfig
): Promise<ToolResult> {
  const retryable = RETRYABLE_TOOLS.has(tool.name);
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < retryConfig.maxAttempts) {
    try {
      const result = await tool.execute(input, ctx);
      return clampResult(tool, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = new ToolExecutionError(message, retryable);
      attempt += 1;
      if (!retryable || attempt >= retryConfig.maxAttempts) {
        break;
      }
      await wait(retryConfig.backoffMs * attempt);
    }
  }

  throw lastError ?? new ToolExecutionError(`Tool ${tool.name} failed`, retryable);
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext = { workspaceRoot: process.cwd(), permissionMode: "default" }
): Promise<string> {
  await initializeTools();
  const startedAt = Date.now();
  const sessionId = ctx.sessionId ?? "default-session";
  const inputSize = Buffer.from(JSON.stringify(input)).byteLength;
  const tool = getTool(name);
  if (!tool) {
    analytics.record({
      toolName: name,
      sessionId,
      agentId: ctx.agentId,
      startedAt,
      durationMs: Date.now() - startedAt,
      success: false,
      errorType: "ToolValidationError",
      inputSize,
      outputSize: 0,
    });
    return `Unknown tool: ${name}`;
  }

  try {
    const toolPermission = await tool.checkPermissions(input, ctx);
    if (!toolPermission.allowed) {
      throw new ToolPermissionError(toolPermission.reason || "unknown reason");
    }

    const modePermission = await resolvePermission(
      {
        toolName: name,
        isReadOnly: tool.isReadOnly(),
        isDestructive: tool.isDestructive(),
        command: typeof input.command === "string" ? input.command : undefined,
      },
      ctx.permissionMode
    );
    if (!modePermission) {
      throw new ToolPermissionError("Tool execution cancelled by user");
    }

    if (tool.onBeforeExecute) {
      await tool.onBeforeExecute(input, ctx);
    }

    const result = await runToolWithRetry(tool, input, ctx, DEFAULT_RETRY_CONFIG);

    if (tool.onAfterExecute) {
      await tool.onAfterExecute(result, ctx);
    }

    analytics.record({
      toolName: name,
      sessionId,
      agentId: ctx.agentId,
      startedAt,
      durationMs: Date.now() - startedAt,
      success: true,
      inputSize,
      outputSize: Buffer.from(result.output).byteLength,
    });
    return result.output;
  } catch (error) {
    if (tool.onError && error instanceof Error) {
      const recovered = await tool.onError(error, ctx);
      if (recovered) {
        const output = clampResult(tool, recovered).output;
        analytics.record({
          toolName: name,
          sessionId,
          agentId: ctx.agentId,
          startedAt,
          durationMs: Date.now() - startedAt,
          success: true,
          inputSize,
          outputSize: Buffer.from(output).byteLength,
        });
        return output;
      }
    }

    const fallbackName = FALLBACK_MAP[name];
    if (fallbackName) {
      const fallbackTool = getTool(fallbackName);
      if (fallbackTool) {
        try {
          const fallbackResult = await fallbackTool.execute(
            {
              command:
                typeof input.pattern === "string"
                  ? `find . -type f | rg "${String(input.pattern).replace(/"/g, '\\"')}"`
                  : "find . -type f",
            },
            ctx
          );
          const output = clampResult(fallbackTool, fallbackResult).output;
          analytics.record({
            toolName: `${name}->${fallbackName}`,
            sessionId,
            agentId: ctx.agentId,
            startedAt,
            durationMs: Date.now() - startedAt,
            success: true,
            inputSize,
            outputSize: Buffer.from(output).byteLength,
          });
          return output;
        } catch {
          // continue to default error output
        }
      }
    }
    const message = `Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`;
    analytics.record({
      toolName: name,
      sessionId,
      agentId: ctx.agentId,
      startedAt,
      durationMs: Date.now() - startedAt,
      success: false,
      errorType: error instanceof Error ? error.name : "UnknownError",
      inputSize,
      outputSize: Buffer.from(message).byteLength,
    });
    return message;
  }
}

export type { Tool, ToolContext, PermissionMode } from "./base";
export const TOOLS = getGenericTools();

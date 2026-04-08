# Sengiku Code — Implementation Roadmap
## 10 Features in 4 Batches

---

## Overview

Implementasi 10 fitur ke Sengiku Code untuk evolve dari basic CLI agent menjadi production-grade extensible coding assistant. Fitur diprioritize berdasarkan dependency order.

| # | Feature | Priority | Batch | Status |
|---|---------|----------|-------|--------|
| 1 | Tool Lifecycle Hooks | High | 1 | DONE (core hooks wired) |
| 2 | Advanced Permission Modes | High | 2 | DONE (plan/role/overrides) |
| 3 | Tool Metadata & Composition | High | 1 | DONE (metadata + registry class) |
| 4 | Better Error Handling | High | 2 | DONE (retry/fallback/error types) |
| 5 | Learning Integration | Medium | 3 | DONE (memory + suggestions) |
| 6 | Agent Context Propagation | High | 1 | DONE (agent breadcrumb propagation) |
| 7 | Dynamic Tool Loading | Medium | 4 | DONE (plugin loader + registry init) |
| 8 | Tool Result Formatting | High | 1 | DONE (ToolResult + truncation) |
| 9 | Tool Analytics | Lower | 3 | DONE (jsonl tracking + /doctor summary) |
| 10 | Streaming Improvements | Lower | 4 | DONE (signal propagation + depth guard) |

---

## Batch 1: Core Interface Overhaul

**Dependencies**: None (foundational)  
**Impactful Files**: `src/tools/base.ts`, `src/tools/registry.ts`  
**Features**: 1, 3, 6, 8

### 1A. Tool Metadata (Feature 3)

Add metadata fields to `Tool` interface dalam `src/tools/base.ts`:

```typescript
interface Tool {
  // existing ...
  isConcurrencySafe(): boolean;       // can run parallel?
  maxResultSizeChars?: number;        // truncate output above limit
  dependencies?: string[];            // tools that must succeed first
  version?: string;                   // for versioning/dynamic loading
  tags?: string[];                    // e.g. ["file", "read-only", "dangerous"]
}
```

Setiap tool file (bash.ts, write-file.ts, etc) implement method baru dengan sensible defaults.

### 1B. Tool Lifecycle Hooks (Feature 1)

Add optional hooks ke `Tool` interface:

```typescript
interface Tool {
  // existing ...
  onBeforeExecute?(input: Record<string, unknown>, ctx: ToolContext): Promise<void>;
  onAfterExecute?(result: ToolResult, ctx: ToolContext): Promise<void>;
  onError?(error: Error, ctx: ToolContext): Promise<ToolResult | null>;  // null = re-throw
}
```

`executeTool()` di registry.ts call hooks in order:
```
onBeforeExecute → execute → onAfterExecute (or onError)
```

### 1C. Structured Result Type (Feature 8)

Replace `execute(): Promise<string>` dengan structured return:

```typescript
interface ToolResult {
  output: string;
  structuredData?: Record<string, unknown>;  // JSON/table data
  truncated?: boolean;                        // output cut at maxResultSizeChars?
  cached?: boolean;                           // came from cache?
  format?: "text" | "json" | "table";
}
```

- `execute()` return `Promise<ToolResult>`
- `executeTool()` return `string` (extract `.output`) untuk backward compat

### 1D. Agent Context Propagation (Feature 6)

Extend `ToolContext` di `src/tools/base.ts`:

```typescript
interface AgentBreadcrumb {
  agentId: string;
  task: string;
  timestamp: number;
}

interface ToolContext {
  workspaceRoot: string;
  permissionMode: PermissionMode;
  // NEW:
  agentId?: string;               // UUID for this agent instance
  parentAgentId?: string;         // if spawned by parent
  breadcrumbs?: AgentBreadcrumb[]; // call chain trace
  role?: UserRole;                 // "viewer" | "editor" | "admin"
  sessionId?: string;              // for analytics grouping
}
```

Update `src/tools/agent.ts` untuk pass parent context ke sub-agents.

### Files untuk Batch 1

| Action | File |
|--------|------|
| MODIFY | `src/tools/base.ts` — extend Tool interface, ToolContext, add ToolResult type |
| MODIFY | `src/tools/registry.ts` — call hooks, handle ToolResult, pass full ctx |
| MODIFY | `src/tools/*.ts` (7 files) — implement new interface methods |
| MODIFY | `src/tools/agent.ts` — propagate context ke sub-agents |

---

## Batch 2: Permissions & Error Handling

**Dependencies**: Batch 1 (needs `UserRole`)  
**Features**: 2, 4

### 2A. Advanced Permission Modes (Feature 2)

Extend `PermissionMode` di `src/tools/base.ts`:

```typescript
type PermissionMode = "default" | "auto" | "plan" | "bypassPermissions";
// "plan" = ask before SETIAP tool, even read-only
// "auto" = approve all, smart warnings untuk truly dangerous
```

Add role-based access di `src/permissions.ts`:

```typescript
type UserRole = "viewer" | "editor" | "admin";

interface ToolPermissionOverride {
  toolName: string;
  mode: PermissionMode;      // override global mode untuk tool ini
  allowedRoles?: UserRole[];
}
```

Updated `resolvePermission()` flow:

1. Check per-tool override dari `.sengiku/permissions.json`
2. Role check: viewer → read-only only; editor → non-destructive; admin → all
3. `plan` mode → ask before setiap tool (even read-only)
4. `bypassPermissions` → skip semua
5. `auto` → smart: allow unless truly dangerous bash pattern
6. `default` → existing behavior (ask for destructive)

Load overrides dari `.sengiku/permissions.json`:

```json
{
  "role": "editor",
  "toolOverrides": [
    { "toolName": "bash", "mode": "plan" },
    { "toolName": "read_file", "mode": "bypassPermissions" }
  ]
}
```

### 2B. Better Error Handling (Feature 4)

Di `executeTool()` dalam `src/tools/registry.ts`:

```typescript
// Retry logic
interface RetryConfig {
  maxAttempts: number;    // default 3 for retryable tools
  backoffMs: number;      // default 500
}

// Error discrimination
class ToolPermissionError extends Error {}
class ToolExecutionError extends Error { retryable: boolean; }
class ToolValidationError extends Error {}

// Fallback tool mapping
const FALLBACK_MAP: Record<string, string> = {
  "search_files": "bash",  // if search_files fails, try bash find
};
```

Updated `executeTool()` flow:

1. Check permissions (throw `ToolPermissionError` on deny)
2. Run `onBeforeExecute` hook
3. Try `tool.execute()` with retry loop (up to `maxAttempts` if `retryable`)
4. On error: call `tool.onError()` → if returns null, try fallback tool → re-throw
5. Run `onAfterExecute` hook
6. Return result

### Files untuk Batch 2

| Action | File |
|--------|------|
| MODIFY | `src/tools/base.ts` — extend PermissionMode, add UserRole |
| MODIFY | `src/permissions.ts` — plan mode, role checks, tool overrides, load config |
| MODIFY | `src/tools/registry.ts` — retry, fallback, error classes, hooks |
| CREATE | `.sengiku/permissions.json` (template) |

---

## Batch 3: Analytics & Learning

**Dependencies**: Batch 1 (needs `ToolResult`), Batch 2 (needs error types)  
**Features**: 5, 9

### 3A. Tool Analytics (Feature 9)

Create `src/analytics.ts`:

```typescript
interface ToolExecution {
  toolName: string;
  sessionId: string;
  agentId?: string;
  startedAt: number;
  durationMs: number;
  success: boolean;
  errorType?: string;
  inputSize: number;    // bytes
  outputSize: number;   // bytes
}

class Analytics {
  private log: ToolExecution[] = [];
  private readonly filePath: string;  // .sengiku/analytics.jsonl

  record(entry: ToolExecution): void;
  flush(): void;          // write to file
  getSummary(): {         // untuk /doctor command
    totalCalls: number;
    byTool: Record<string, { 
      calls: number; 
      avgMs: number; 
      errorRate: number 
    }>;
  };
}

export const analytics = new Analytics(
  path.join(process.cwd(), ".sengiku/analytics.jsonl")
);
```

Di `executeTool()`: wrap execution dengan timing dan record ke `analytics`.

### 3B. Learning Integration (Feature 5)

Update `src/index.ts` `LearningMemory`:

```typescript
interface LearningMemory {
  projectGoal: string;
  codingStyle: string[];
  preferredCommands: string[];
  // NEW:
  frequentTools: string[];        // auto-updated dari analytics
  lastActive: string;             // ISO date
  preferredWorkflow: string;      // derived dari usage patterns
}
```

After setiap tool execution:
- `analytics.record()` 
- update `frequentTools` di `memory.json`

Create `src/suggestions.ts` dengan `autoSuggest(input: string): string[]` yang:
- Match input keywords ke likely tools (e.g. "find file" → suggest `search_files`)
- Show inline suggestions di REPL prompt: `❯  [Suggested: search_files, list_dir]`

### Files untuk Batch 3

| Action | File |
|--------|------|
| CREATE | `src/analytics.ts` — ToolExecution type, Analytics class |
| CREATE | `src/suggestions.ts` — autoSuggest() based on analytics |
| MODIFY | `src/tools/registry.ts` — instrument executeTool dengan analytics |
| MODIFY | `src/index.ts` — update LearningMemory, show suggestions, flush analytics |
| MODIFY | `src/commands/doctor.ts` — add analytics summary ke /doctor output |

---

## Batch 4: Dynamic Loading & Streaming

**Dependencies**: Batch 1 (needs `Tool` interface)  
**Features**: 7, 10

### 4A. Dynamic Tool Loading (Feature 7)

Update `src/tools/registry.ts`:

```typescript
// Plugin discovery
async function loadPluginTools(pluginDir: string): Promise<Tool[]> {
  // scan .sengiku/plugins/*.ts for default exports implementing Tool
}

// Versioned registry
class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void;       // overwrites older version
  unregister(name: string): void;
  get(name: string): Tool | undefined;
  getAll(): Tool[];
}

export const registry = new ToolRegistry();
// On startup: register built-in tools, then scan .sengiku/plugins/
```

`TOOLS` export becomes `registry.getAll().map(toGenericTool)`.

Plugin format: `.sengiku/plugins/my-tool.ts` exports `default` implementing `Tool`.

### 4B. Streaming Improvements (Feature 10)

Add `AbortController` support ke `ToolContext`:

```typescript
interface ToolContext {
  // existing + Batch 1 additions ...
  signal?: AbortSignal;   // passed from REPL, forwarded to tool
}
```

Add progress reporting via optional generator:

```typescript
interface Tool {
  // New overload for long-running tools:
  executeStreaming?(
    input: Record<string, unknown>,
    ctx: ToolContext,
    onProgress: (msg: string) => void
  ): AsyncGenerator<string>;
}
```

Di `src/index.ts`:
- Create `AbortController` per user input
- Wire Ctrl+C ke `controller.abort()`
- Pass `signal` dalam `ToolContext` ke semua `executeTool()` calls

Di providers: add `const MAX_TOOL_DEPTH = 10` guard pada recursion/iteration.

### Files untuk Batch 4

| Action | File |
|--------|------|
| MODIFY | `src/tools/registry.ts` — replace `toolInstances[]` dengan `ToolRegistry` class |
| MODIFY | `src/tools/base.ts` — add `signal`, `executeStreaming`, metadata |
| CREATE | `src/tools/loader.ts` — `loadPluginTools()`, plugin scanning |
| MODIFY | `src/index.ts` — AbortController per prompt, Ctrl+C wiring |
| MODIFY | `src/providers/anthropic.ts` — MAX_TOOL_DEPTH guard, pass signal |
| MODIFY | `src/providers/openai-compat.ts` — MAX_TOOL_DEPTH guard, pass signal |

---

## Implementation Timeline

```
Batch 1: Core Interfaces (4 features)
  └─ Batch 2: Permissions & Error Handling (2 features)
      └─ Batch 3: Analytics & Learning (2 features)
          └─ Batch 4: Dynamic & Streaming (2 features)
```

**Sequential** karena setiap batch depends on previous.

---

## Verification Strategy

```bash
# After Batch 1: Tool interface
bun run typecheck
echo 'read package.json' | bun run index.ts
# ✓ hooks fire, ToolResult returned, context propagated

# After Batch 2: Permissions
echo 'bash(command: "ls -la")' | bun run index.ts
# ✓ asks for permission (destructive tool)

# After Batch 3: Analytics
/doctor
# ✓ shows tool call analytics summary
# ✓ memory shows frequentTools updated

# After Batch 4: Dynamic + Streaming  
# ✓ custom tool loads dari .sengiku/plugins/
# ✓ Ctrl+C aborts running tool cleanly
```

---

## Files Summary

**Most Critical (touch multiple times):**
- `src/tools/base.ts` — interface definitions
- `src/tools/registry.ts` — execution engine
- `src/index.ts` — REPL wiring
- `src/permissions.ts` — permission logic

**New Files:**
- `src/analytics.ts` — ToolExecution tracking
- `src/suggestions.ts` — auto-suggest logic
- `src/tools/loader.ts` — plugin loading
- `.sengiku/permissions.json` — config template

**Supporting Changes:**
- All `src/tools/*.ts` (7 tool files) — implement new interface methods
- `src/providers/anthropic.ts` — MAX_TOOL_DEPTH, signal handling
- `src/providers/openai-compat.ts` — MAX_TOOL_DEPTH, signal handling
- `src/commands/doctor.ts` — analytics summary display

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ToolExecution {
  toolName: string;
  sessionId: string;
  correlationId?: string;
  agentId?: string;
  startedAt: number;
  durationMs: number;
  success: boolean;
  errorType?: string;
  inputSize: number;
  outputSize: number;
  policyAllowed?: boolean;
  policyReason?: string;
}

interface ToolSummary {
  calls: number;
  avgMs: number;
  errorRate: number;
}

interface AnalyticsSummary {
  totalCalls: number;
  byTool: Record<string, ToolSummary>;
}

class Analytics {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  record(entry: ToolExecution): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  flush(): void {
    // no-op because writes are append-immediate
  }

  getSummary(): AnalyticsSummary {
    if (!existsSync(this.filePath)) {
      return { totalCalls: 0, byTool: {} };
    }

    const rows = readFileSync(this.filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const byToolRaw: Record<string, { calls: number; totalMs: number; errors: number }> = {};
    for (const row of rows) {
      try {
        const entry = JSON.parse(row) as ToolExecution;
        if (!byToolRaw[entry.toolName]) {
          byToolRaw[entry.toolName] = { calls: 0, totalMs: 0, errors: 0 };
        }
        const bucket = byToolRaw[entry.toolName];
        if (!bucket) {
          continue;
        }
        bucket.calls += 1;
        bucket.totalMs += entry.durationMs;
        if (!entry.success) {
          bucket.errors += 1;
        }
      } catch {
        // skip malformed line
      }
    }

    const byTool: Record<string, ToolSummary> = {};
    for (const [toolName, data] of Object.entries(byToolRaw)) {
      byTool[toolName] = {
        calls: data.calls,
        avgMs: data.calls > 0 ? Math.round(data.totalMs / data.calls) : 0,
        errorRate: data.calls > 0 ? Number((data.errors / data.calls).toFixed(2)) : 0,
      };
    }

    return { totalCalls: rows.length, byTool };
  }
}

export const analytics = new Analytics(
  path.join(process.cwd(), ".sengiku", "analytics.jsonl")
);


export interface EvalResult {
  id: string;
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] || 0;
}

export function buildEvalReport(results: EvalResult[]): {
  total: number;
  passed: number;
  successRate: number;
  p50: number;
  p95: number;
  failures: EvalResult[];
} {
  const passed = results.filter((r) => r.ok).length;
  const latencies = results.map((r) => r.latencyMs);
  return {
    total: results.length,
    passed,
    successRate: results.length ? Number(((passed / results.length) * 100).toFixed(2)) : 0,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    failures: results.filter((r) => !r.ok),
  };
}


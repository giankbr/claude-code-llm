import { readFileSync } from "node:fs";
import path from "node:path";
import { executeTool, getTool, initializeTools } from "../tools/registry";
import { normalizeToolCallAlias } from "../tools/alias-map";
import { evaluatePolicy } from "../policy";
import { validateToolInput } from "../tools/validate";
import type { PermissionMode } from "../tools/base";
import type { EvalResult } from "./report";

type Scenario = Record<string, any>;

function nowMs(): number {
  return Date.now();
}

export async function runEvalScenarios(): Promise<EvalResult[]> {
  await initializeTools();
  const scenarioPath = path.join(process.cwd(), "src", "eval", "scenarios.json");
  const scenarios = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario[];
  const results: EvalResult[] = [];

  for (const scenario of scenarios) {
    const startedAt = nowMs();
    let ok = false;
    let detail = "";
    try {
      if (scenario.kind === "alias") {
        const out = normalizeToolCallAlias(scenario.input);
        ok =
          out.name === scenario.expectName &&
          (scenario.expectAction ? out.arguments.action === scenario.expectAction : true);
      } else if (scenario.kind === "policy") {
        const tool = getTool(scenario.tool);
        if (!tool) {
          throw new Error(`Missing tool: ${scenario.tool}`);
        }
        const mode = (scenario.mode || "default") as PermissionMode;
        const decision = evaluatePolicy(tool, scenario.args || {}, mode);
        ok = decision.allowed === scenario.expectAllowed;
      } else if (scenario.kind === "validation") {
        const tool = getTool(scenario.tool);
        if (!tool) {
          throw new Error(`Missing tool: ${scenario.tool}`);
        }
        const out = validateToolInput(tool, scenario.args || {});
        ok = out.ok === scenario.expectValid;
      } else if (scenario.kind === "execute") {
        const output = await executeTool(scenario.tool, scenario.args || {}, {
          workspaceRoot: process.cwd(),
          permissionMode: "default",
          sessionId: "eval",
          correlationId: `eval-${scenario.id}`,
        });
        ok = typeof output === "string" && output.includes(String(scenario.expectContains || ""));
      } else {
        throw new Error(`Unknown kind: ${scenario.kind}`);
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
      ok = false;
    }
    results.push({
      id: scenario.id,
      ok,
      latencyMs: nowMs() - startedAt,
      detail: detail || undefined,
    });
  }
  return results;
}


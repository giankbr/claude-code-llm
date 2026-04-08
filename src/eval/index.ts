import { runEvalScenarios } from "./runner";
import { buildEvalReport } from "./report";

const MIN_SUCCESS_RATE = Number(process.env.EVAL_MIN_SUCCESS_RATE || "80");

async function main(): Promise<void> {
  const results = await runEvalScenarios();
  const report = buildEvalReport(results);
  console.log(JSON.stringify(report, null, 2));
  if (report.successRate < MIN_SUCCESS_RATE) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});


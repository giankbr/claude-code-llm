import { describe, expect, test } from "bun:test";
import { executeTool, getGenericTools } from "./registry";

describe("tool registry policy and schema", () => {
  test("enriches generic tool descriptions with catalog guidance", () => {
    const tools = getGenericTools();
    const bash = tools.find((tool) => tool.name === "bash");
    expect(bash).toBeDefined();
    expect(bash?.description).toContain("Tool-specific guidance:");
    expect(bash?.description).toContain("IMPORTANT:");
    expect(bash?.description).toContain("Git operations:");
  });

  test("blocks disallowed bash utility at strict policy gate", async () => {
    const output = await executeTool(
      "bash",
      { command: "cat package.json" },
      { workspaceRoot: process.cwd(), permissionMode: "bypassPermissions", sessionId: "test-session" }
    );
    expect(output).toContain("Policy blocked:");
  });
});

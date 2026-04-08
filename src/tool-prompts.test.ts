import { describe, expect, test } from "bun:test";
import { composeToolDescription, formatToolPromptSection } from "./tool-prompts";
import { getSystemPrompt } from "./prompts";

describe("tool prompt catalog", () => {
  test("composes tool description with guidance", () => {
    const composed = composeToolDescription("Base description", "bash");
    expect(composed).toContain("Base description");
    expect(composed).toContain("Tool-specific guidance:");
    expect(composed).toContain("IMPORTANT:");
    expect(composed).toContain("Git operations:");
  });

  test("formats per-tool section deterministically", () => {
    const section = formatToolPromptSection("search_files");
    expect(section).toContain("Tool: search_files");
    expect(section).toContain("Use");
    expect(section).toContain("Safety");
  });

  test("injects tool prompt bundle into system code prompt", () => {
    const previous = process.env.SYSTEM_PROMPT_TYPE;
    process.env.SYSTEM_PROMPT_TYPE = "code";
    const prompt = getSystemPrompt();
    if (previous === undefined) {
      delete process.env.SYSTEM_PROMPT_TYPE;
    } else {
      process.env.SYSTEM_PROMPT_TYPE = previous;
    }
    expect(prompt).toContain("Tool-Specific Prompt Bundle:");
    expect(prompt).toContain("Tool: bash");
    expect(prompt).toContain("Tool: read_file");
  });
});

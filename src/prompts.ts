import { PROMPT_MODULES, buildPromptHeader } from "./prompt-modules";
import { buildToolPromptBundle, TOOL_PROMPT_CATALOG } from "./tool-prompts";

function buildModularCodePrompt(): string {
  const stablePrefix = PROMPT_MODULES.filter((module) => module.stable);
  const dynamicSuffix = PROMPT_MODULES.filter((module) => !module.stable);
  const toolPromptBundle = buildToolPromptBundle(
    Object.keys(TOOL_PROMPT_CATALOG).map((name) => ({ name }))
  );

  return [
    "Sengiku Prompt Assembly (Modular)",
    "",
    "Stable Prefix:",
    buildPromptHeader(stablePrefix),
    "",
    "Dynamic Suffix:",
    buildPromptHeader(dynamicSuffix),
    "",
    "Tool-Specific Prompt Bundle:",
    toolPromptBundle,
    "",
    "Runtime policy:",
    "- Use only registered tools and follow permission checks.",
    "- Keep edits scoped to user request and requested target path.",
    "- Enforce stack fidelity and verification before concluding implementation tasks.",
  ].join("\n");
}

export const SYSTEM_PROMPTS = {
  code: buildModularCodePrompt(),

  general: `You are Sengiku Code, a local AI agent. When the user asks you to read files, write files, or run commands, use the available tools.`,
  minimal: `You are Sengiku Code. Help with code tasks using available tools (read_file, write_file, bash, list_dir, search_files).`,
};

export function getSystemPrompt(): string {
  const promptType = process.env.SYSTEM_PROMPT_TYPE || "code";
  return SYSTEM_PROMPTS[promptType as keyof typeof SYSTEM_PROMPTS] || SYSTEM_PROMPTS.code;
}

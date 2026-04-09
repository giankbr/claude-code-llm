import { PROMPT_MODULES, buildPromptHeader } from "./prompt-modules";
import { buildToolPromptBundle, TOOL_PROMPT_CATALOG } from "./tool-prompts";

function pickDynamicModules(taskHint: string) {
  const dynamic = PROMPT_MODULES.filter((module) => !module.stable);
  const lower = taskHint.toLowerCase();
  if (/git|branch|commit|diff|log/.test(lower)) {
    return dynamic.filter((module) => ["15", "16", "22", "29"].includes(module.id));
  }
  if (/plugin|install|tools|command/.test(lower)) {
    return dynamic.filter((module) => ["16", "20", "27", "30"].includes(module.id));
  }
  return dynamic.slice(0, 3);
}

const TOOL_USE_RULES = `
🔴 CRITICAL: YOU MUST EMIT TOOL CALLS AS JSON - NO EXCEPTIONS

When user asks to modify files or run commands:
1. FIRST: Output tool calls as JSON objects (required, non-negotiable)
2. THEN: Explain what you did (optional)

JSON FORMAT (mandatory):
{
  "name": "tool_name",
  "arguments": {"key": "value", ...}
}

REAL EXAMPLES FOR INDONESIAN REQUESTS:

Request: "ubah index.html jadi Sengoku"
Response must include:
{"name": "read_file", "arguments": {"path": "index.html"}}
{"name": "edit_file", "arguments": {"path": "index.html", "find": "Sengiku", "replace": "Sengoku"}}

Request: "buat file baru server.js"
Response must include:
{"name": "write_file", "arguments": {"path": "server.js", "content": "// file content here"}}

Request: "jalankan npm install"
Response must include:
{"name": "bash", "arguments": {"command": "npm install"}}

RULES:
1. JSON comes BEFORE any explanation text
2. Each operation = one JSON block
3. ALWAYS include all required arguments (path, content, command, etc.)
4. NEVER output just descriptions - ALWAYS include actual JSON
5. If text alone won't solve it, emit JSON tool calls

WARNING: If you don't emit JSON tool calls, the system cannot execute your intentions. JSON is required.
`.trim();

function buildModularCodePrompt(taskHint = ""): string {
  const stablePrefix = PROMPT_MODULES.filter((module) => module.stable);
  const dynamicSuffix = pickDynamicModules(taskHint);
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
    TOOL_USE_RULES,
    "",
    "Runtime policy:",
    "- Use only registered tools and follow permission checks.",
    "- Keep edits scoped to user request and requested target path.",
    "- Enforce stack fidelity and verification before concluding implementation tasks.",
    "- Support both Indonesian and English. Never refuse a user message only because it is in Indonesian.",
  ].join("\n");
}

export const SYSTEM_PROMPTS = {
  code: buildModularCodePrompt(""),

  general: `You are Sengiku Code, a local AI agent. Support both Indonesian and English naturally. When the user asks you to read files, write files, or run commands, use the available tools.`,
  minimal: `You are Sengiku Code. Support Indonesian and English. Help with code tasks using available tools (read_file, write_file, bash, list_dir, search_files).`,
};

export function getSystemPrompt(): string {
  const promptType = process.env.SYSTEM_PROMPT_TYPE || "code";
  return SYSTEM_PROMPTS[promptType as keyof typeof SYSTEM_PROMPTS] || SYSTEM_PROMPTS.code;
}

export function getSystemPromptForTask(taskHint: string): string {
  const promptType = process.env.SYSTEM_PROMPT_TYPE || "code";
  if (promptType !== "code") {
    return getSystemPrompt();
  }
  return buildModularCodePrompt(taskHint);
}

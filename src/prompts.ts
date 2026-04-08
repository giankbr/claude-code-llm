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
CRITICAL TOOL-USE RULES (follow strictly):

1. ONE TOOL CALL PER STEP. Complete one action, see the result, then decide the next.
2. NEVER call the same tool twice in a row with the same arguments.
3. NEVER call list_dir or read_file without a specific path argument.
4. ALWAYS provide ALL required arguments. Never send empty {}.
5. After writing a file, move to the NEXT file — do not rewrite the same file.
6. When user asks a follow-up (e.g. "can you run it?"), refer to files you just created, not random files.

TOOL CALL PATTERNS:

Create multiple files (scaffold):
  Step 1: write_file({"path":"api/server.js","content":"..."})
  Step 2: write_file({"path":"api/routes/users.js","content":"..."})
  Step 3: write_file({"path":"api/package.json","content":"..."})
  Step 4: bash({"command":"cd api && npm install"})

Edit existing file:
  Step 1: read_file({"path":"index.html"})
  Step 2: edit_file({"path":"index.html","find":"<old text>","replace":"<new text>"})

Run a project:
  Step 1: read_file({"path":"package.json"})  — check scripts
  Step 2: bash({"command":"node api/server.js"})

IMPORTANT: text responses alone do NOT modify files. You MUST call tools.
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

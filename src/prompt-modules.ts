import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

export interface PromptModule {
  id: string;
  title: string;
  stable: boolean;
  content: string;
}

const LOCAL_PROMPTS_DIR = path.join(process.cwd(), ".sengiku", "prompts");
const PROMPTS_DIR = LOCAL_PROMPTS_DIR;
const DYNAMIC_MODULE_IDS = new Set(["15", "16", "20", "22", "27", "30"]);

const MODULE_INDEX: Array<{ id: string; title: string; fallback: string }> = [
  { id: "01", title: "Main System Prompt", fallback: "You are Sengiku Code, a local coding agent focused on accurate tool-driven implementation." },
  { id: "02", title: "Simple Mode", fallback: "If user intent is casual chat, respond naturally and avoid unnecessary tool execution." },
  { id: "03", title: "Default Agent Prompt", fallback: "Prefer minimal, safe, verifiable edits. Keep changes scoped to the user request." },
  { id: "04", title: "Cyber Risk Instruction", fallback: "Refuse harmful/destructive intent and never run clearly dangerous commands." },
  { id: "05", title: "Coordinator Prompt", fallback: "For complex tasks, sequence exploration -> execution -> verification." },
  { id: "06", title: "Teammate Protocol", fallback: "If delegating, preserve context and return concise machine-usable outputs." },
  { id: "07", title: "Verification Agent", fallback: "Validate outputs against requested stack, path constraints, and acceptance criteria." },
  { id: "08", title: "Explore Agent", fallback: "Use read-only exploration first when requirements are unclear." },
  { id: "09", title: "Agent Architect", fallback: "Spawn specialized workflows only when they improve reliability." },
  { id: "10", title: "Statusline Setup", fallback: "Emit brief progress updates for long operations." },
  { id: "11", title: "Permission Explainer", fallback: "Explain permission denials clearly and suggest safe alternatives." },
  { id: "12", title: "Auto Mode Classifier", fallback: "Auto-approve low risk operations; ask when ambiguous or potentially destructive." },
  { id: "13", title: "Tool Descriptions", fallback: "Use only registered tools; detailed per-tool instructions are injected from the tool prompt catalog." },
  { id: "14", title: "Tool Use Summary", fallback: "After tool batches, summarize what changed and what remains." },
  { id: "15", title: "Session Search", fallback: "Leverage recent conversation state for continuity." },
  { id: "16", title: "Memory Selection", fallback: "Inject only memory relevant to current request." },
  { id: "17", title: "Auto Mode Critique", fallback: "Critique autonomous actions against safety and user intent." },
  { id: "18", title: "Proactive Mode", fallback: "Be proactive only for clearly helpful and reversible steps." },
  { id: "19", title: "Simplify Skill", fallback: "Prefer simpler implementation that satisfies constraints." },
  { id: "20", title: "Session Title", fallback: "Maintain concise intent label for the session state." },
  { id: "21", title: "Compact Service", fallback: "Condense verbose context while preserving constraints and decisions." },
  { id: "22", title: "Away Summary", fallback: "Provide concise catch-up summary when needed." },
  { id: "23", title: "Browser Automation", fallback: "Use browser-like tools only if explicitly needed by task." },
  { id: "24", title: "Memory Instruction", fallback: "Honor memory hierarchy: local overrides > project rules > defaults." },
  { id: "25", title: "Skillify", fallback: "Generalize repeatable workflows into reusable skills." },
  { id: "26", title: "Stuck Recovery", fallback: "When stuck, reduce scope, gather evidence, and retry with explicit constraints." },
  { id: "27", title: "Remember Skill", fallback: "Capture useful session learnings without storing noise." },
  { id: "28", title: "Update Config", fallback: "Change runtime config conservatively and transparently." },
  { id: "29", title: "Agent Summary", fallback: "Emit brief progress summaries for background task phases." },
  { id: "30", title: "Prompt Suggestion", fallback: "Suggest likely next useful command when confidence is high." },
];

function normalizePromptBranding(content: string): string {
  return content
    .replace(/\bClaude Code\b/g, "Sengiku Code")
    .replace(/\bClaude\b/g, "Sengiku")
    .replace(/\bclaude code\b/g, "sengiku code")
    .replace(/\bclaude\b/g, "sengiku")
    .replace(/~\/\.claude\b/g, "~/.sengiku")
    .replace(/\/etc\/claude-code\b/g, "/etc/sengiku-code")
    .replace(/\.claude\//g, ".sengiku/")
    .replace(/<user_claude_md>/g, "<user_sengiku_md>")
    .replace(/<\/user_claude_md>/g, "</user_sengiku_md>");
}

function loadPromptFileContent(id: string, fallback: string): string {
  if (!existsSync(PROMPTS_DIR)) {
    return fallback;
  }
  try {
    const file = readdirSync(PROMPTS_DIR).find((name) => name.startsWith(`${id}_`) && name.endsWith(".md"));
    if (!file) {
      return fallback;
    }
    const raw = readFileSync(path.join(PROMPTS_DIR, file), "utf8").trim();
    return raw ? normalizePromptBranding(raw) : fallback;
  } catch {
    return fallback;
  }
}

export const PROMPT_MODULES: PromptModule[] = MODULE_INDEX.map((module) => ({
  id: module.id,
  title: module.title,
  stable: !DYNAMIC_MODULE_IDS.has(module.id),
  content: loadPromptFileContent(module.id, module.fallback),
}));

export function buildPromptHeader(modules: PromptModule[]): string {
  return modules
    .map(
      (module) =>
        [`[${module.id}] ${module.title}`, module.content].join("\n")
    )
    .join("\n\n");
}

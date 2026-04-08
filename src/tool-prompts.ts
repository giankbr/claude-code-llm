import type { Tool } from "./tools/base";

export interface ToolPromptSpec {
  fullPrompt?: string;
  usagePrompt: string;
  safetyPrompt: string;
  examples?: string[];
}

const DEFAULT_TOOL_PROMPT: ToolPromptSpec = {
  usagePrompt:
    "Use the tool only when it is the most direct way to satisfy the user request.",
  safetyPrompt:
    "Respect workspace boundaries, permission checks, and avoid destructive actions unless explicitly requested.",
};

export const TOOL_PROMPT_CATALOG: Record<string, ToolPromptSpec> = {
  read_file: {
    usagePrompt:
      "Read files before proposing edits. Prefer this over shell commands like cat/head/tail.",
    safetyPrompt:
      "Read only paths inside the workspace and avoid reading unrelated large files.",
    examples: ['{"name":"read_file","arguments":{"path":"src/index.ts"}}'],
  },
  write_file: {
    usagePrompt:
      "Create or overwrite text files when user asks for file creation or full rewrites.",
    safetyPrompt:
      "Prefer edit_file for targeted updates. Verify target directory first with list_dir before writing new files.",
    examples: ['{"name":"write_file","arguments":{"path":"src/new.ts","content":"export {};"}}'],
  },
  edit_file: {
    fullPrompt: `Performs exact string replacements in files.

Usage:
- You must use your read_file tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from read_file output, ensure you preserve the exact indentation (tabs/spaces).
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it.
- The edit will fail if find text is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use broad replacement to change every instance.
- Use broad replacement for replacing and renaming strings across the file.`,
    usagePrompt:
      "Use exact string replacement for localized file changes after reading the file first.",
    safetyPrompt:
      "Preserve formatting and provide sufficiently unique find text to avoid accidental broad replacement.",
    examples: [
      '{"name":"edit_file","arguments":{"path":"src/a.ts","find":"const a = 1;","replace":"const a = 2;"}}',
    ],
  },
  list_dir: {
    usagePrompt:
      "Inspect directory structure and verify parents before create/write operations.",
    safetyPrompt:
      "List only relevant directories and keep exploration scoped to user intent.",
  },
  search_files: {
    usagePrompt:
      "Search file names by regex and prefer this over shell find/ls for discovery.",
    safetyPrompt:
      "Use focused patterns and start_path to avoid broad scans unless user asks for exhaustive search.",
    examples: ['{"name":"search_files","arguments":{"pattern":".*\\\\.ts$","start_path":"src"}}'],
  },
  bash: {
    fullPrompt: `Executes a given bash command and returns its output.

The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).

IMPORTANT: Avoid using this tool to run find, grep, cat, head, tail, sed, awk, or echo commands, unless explicitly instructed or after verifying that a dedicated tool cannot accomplish the task. Instead:
- File search: Use search_files (NOT find or ls)
- Content search: Use ripgrep/search tool (NOT grep or rg in bash)
- Read files: Use read_file (NOT cat/head/tail)
- Edit files: Use edit_file (NOT sed/awk)
- Write files: Use write_file (NOT echo > file / cat <<EOF)
- Communication: Output text directly (NOT echo/printf)

Instructions:
- Before creating new directories/files, use list_dir to verify parent exists.
- Always quote file paths containing spaces with double quotes.
- Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of cd.
- You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). Default timeout is 120000ms (2 minutes).
- You can use background execution for long-running commands.
- When issuing multiple commands:
  - If commands are independent, make multiple shell calls in parallel.
  - If commands depend on each other, use && to chain them.
  - Do not use newlines to separate commands.
- For git commands:
  - Prefer to create a new commit rather than amending an existing commit.
  - Before running destructive operations, consider safer alternatives.
  - Never skip hooks unless explicitly asked.
- Avoid unnecessary sleep commands.

Git operations:
- Follow safe flow: status -> diff -> log -> add -> commit.
- Never change git config automatically.
- Never run destructive git operations unless user explicitly requests them.

Sandbox awareness:
- Respect filesystem and network restrictions from runtime policy.
- Use temporary directories appropriate for the environment when needed.`,
    usagePrompt:
      "Run shell commands for execution tasks (build/test/install/git) when dedicated tools are insufficient.",
    safetyPrompt:
      "Avoid destructive commands and avoid find/grep/cat/head/tail/sed/awk/echo unless explicitly required.",
    examples: ['{"name":"bash","arguments":{"command":"bun run typecheck"}}'],
  },
  agent: {
    fullPrompt: `Launches a sub-agent to handle a complex, multi-step task autonomously.

The agent tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do.
- Launch multiple agents concurrently whenever possible, to maximize performance.
- When the agent is done, it will return a single result to the parent context. The result is not shown directly to the user; summarize it.
- You can optionally run agents in the background.
- To continue a previously spawned agent, resume the same agent context/id.
- The agent outputs should generally be trusted.
- Clearly tell the agent whether you expect it to write code or just do research.
- Optionally run isolated/worktree-style execution when needed.

When to fork:
- Fork for open-ended research and for implementation tasks requiring more than a couple of edits.
- Do not read/tail intermediate output unless explicitly asked.
- Never fabricate or predict unfinished fork results.`,
    usagePrompt:
      "Delegate complex multi-step tasks to sub-agents and include concrete task/context constraints.",
    safetyPrompt:
      "Do not delegate trivial single-tool actions and always summarize results back to the user.",
    examples: [
      '{"name":"agent","arguments":{"task":"Audit API error handling","context":"read-only, report findings"}}',
    ],
  },
};

export function getToolPrompt(toolName: string): ToolPromptSpec {
  return TOOL_PROMPT_CATALOG[toolName] ?? DEFAULT_TOOL_PROMPT;
}

export function formatToolPromptSection(toolName: string): string {
  const spec = getToolPrompt(toolName);
  if (spec.fullPrompt) {
    return `Tool: ${toolName}\n${spec.fullPrompt}`;
  }
  const lines = [
    `Tool: ${toolName}`,
    `- Usage: ${spec.usagePrompt}`,
    `- Safety: ${spec.safetyPrompt}`,
  ];
  if (spec.examples?.length) {
    lines.push(`- Example: ${spec.examples[0]}`);
  }
  return lines.join("\n");
}

export function buildToolPromptBundle(tools: Pick<Tool, "name">[]): string {
  return tools.map((tool) => formatToolPromptSection(tool.name)).join("\n\n");
}

export function composeToolDescription(baseDescription: string, toolName: string): string {
  const spec = getToolPrompt(toolName);
  if (spec.fullPrompt) {
    return `${baseDescription.trim()}\n\nTool-specific guidance:\n${spec.fullPrompt}`;
  }
  const guidance = [
    "Tool-specific guidance:",
    `- Usage: ${spec.usagePrompt}`,
    `- Safety: ${spec.safetyPrompt}`,
  ];
  if (spec.examples?.length) {
    guidance.push(`- Example: ${spec.examples[0]}`);
  }
  return `${baseDescription.trim()}\n\n${guidance.join("\n")}`;
}

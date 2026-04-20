import inquirer from "inquirer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GenericMessage, GenericTool } from "./providers/base";
import { streamResponse } from "./client";
import {
  colors,
  printHeader,
  printChatDivider,
  printToolSectionHeader,
  printToolCall,
  printToolResult,
  renderMarkdown,
  promptSymbol,
  printPromptFooter,
  startStickyLoading,
  updateStickyLoading,
  stopStickyLoading,
} from "./ui";
import { isCommand, handleCommand } from "./commands/registry";
import { executeTool } from "./tools/registry";
import { autoSuggest } from "./suggestions";
import { analytics } from "./analytics";
import type { PermissionMode } from "./tools/base";
import { evaluateToolExecution, type ExecutedToolEvent } from "./quality-gate";
import { normalizeToolCallAlias, type TextToolCall } from "./tools/alias-map";
import { formatOpenAICompatConnectionError } from "./providers/openai-compat";

const messages: GenericMessage[] = [];
const SENGIKU_DIR = path.join(process.cwd(), ".sengiku");
const SENGIKU_RULES_FILE = path.join(SENGIKU_DIR, "rules.md");
const SENGIKU_MEMORY_FILE = path.join(SENGIKU_DIR, "memory.json");

type LearningMemory = {
  projectGoal: string;
  codingStyle: string[];
  preferredCommands: string[];
  frequentTools: string[];
  lastActive: string;
  preferredWorkflow: string;
};

function getSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getCorrelationId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeShorthandWorkspacePath(input: string): string {
  return input.replace(/(^|\s)\/([A-Za-z0-9._-]+)(?=\s|$|[.,;:!?])/g, (full, prefix, name) => {
    const candidate = path.join(process.cwd(), name);
    if (existsSync(candidate)) {
      return `${prefix}${name}`;
    }
    return full;
  });
}

function updateMemoryFromAnalytics(): void {
  if (!existsSync(SENGIKU_MEMORY_FILE)) {
    return;
  }
  try {
    const raw = readFileSync(SENGIKU_MEMORY_FILE, "utf8");
    const memory = JSON.parse(raw) as LearningMemory;
    const summary = analytics.getSummary();
    const frequentTools = Object.entries(summary.byTool)
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 5)
      .map(([toolName]) => toolName);
    const updated: LearningMemory = {
      ...memory,
      frequentTools,
      lastActive: new Date().toISOString(),
      preferredWorkflow:
        memory.preferredWorkflow ||
        "tool-first execution with iterative follow-up",
    };
    writeFileSync(SENGIKU_MEMORY_FILE, JSON.stringify(updated, null, 2));
  } catch {
    // ignore memory update failures
  }
}

function parseLooseJsonObject(input: string): Record<string, unknown> | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Try normalizing quotes and property names
    let normalized = trimmed
      .replace(/'/g, "\"")
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');

    try {
      return JSON.parse(normalized) as Record<string, unknown>;
    } catch {
      // Last resort: try to strip trailing comma before }
      try {
        const withoutTrailingComma = normalized.replace(/,(\s*[}\]])/g, '$1');
        return JSON.parse(withoutTrailingComma) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
}

function collectObjectLikeSnippets(text: string): string[] {
  const snippets = new Set<string>();

  // 1. Extract fenced code blocks (```json, ```js, etc.)
  const blocks = text.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/gi) || [];
  for (const block of blocks) {
    const inner = block
      .replace(/^```(?:json|javascript|js)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    if (inner.startsWith("{") && inner.endsWith("}")) {
      snippets.add(inner);
    }
  }

  // 2. Extract single-line JSON objects
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      snippets.add(trimmed);
    }
  }

  // 3. Extract multi-line JSON objects (greedy matching)
  const multiLineMatches = text.match(/\{[\s\S]*?\}/g) || [];
  for (const match of multiLineMatches) {
    if (match.trim().startsWith("{") && match.trim().endsWith("}")) {
      snippets.add(match.trim());
    }
  }

  // 4. Check if entire trimmed text is a JSON object
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    snippets.add(trimmed);
  }

  return Array.from(snippets);
}

function extractTextToolCalls(text: string): TextToolCall[] {
  const calls: TextToolCall[] = [];
  const snippets = collectObjectLikeSnippets(text);

  for (const snippet of snippets) {
    const parsed = parseLooseJsonObject(snippet) as
      | { name?: unknown; arguments?: unknown }
      | null;
    if (
      parsed &&
      typeof parsed.name === "string" &&
      parsed.arguments &&
      typeof parsed.arguments === "object"
    ) {
      calls.push({
        name: parsed.name,
        arguments: parsed.arguments as Record<string, unknown>,
      });
    }
  }

  const boxRegex =
    /<\|begin_of_box\|>\s*([A-Za-z0-9._-]+)\s*([\s\S]*?)<\/tool_call>/gi;
  let boxMatch: RegExpExecArray | null = boxRegex.exec(text);
  while (boxMatch) {
    const toolName = (boxMatch[1] || "").trim();
    const body = boxMatch[2] || "";
    if (toolName) {
      const args: Record<string, unknown> = {};
      const pairRegex =
        /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi;
      let pairMatch: RegExpExecArray | null = pairRegex.exec(body);
      while (pairMatch) {
        const key = (pairMatch[1] || "").trim();
        const value = (pairMatch[2] || "").trim();
        if (key) {
          args[key] = value;
        }
        pairMatch = pairRegex.exec(body);
      }
      calls.push({ name: toolName, arguments: args });
    }
    boxMatch = boxRegex.exec(text);
  }

  return calls;
}

function isNoOpTextToolCall(call: TextToolCall): boolean {
  if (call.name === "echo_tool") {
    return true;
  }
  return false;
}

function unwrapEchoToolTextResponse(text: string): string {
  const calls = extractTextToolCalls(text);
  if (calls.length !== 1) {
    return text;
  }
  const [call] = calls;
  if (!call || call.name !== "echo_tool") {
    return text;
  }
  const maybeText = call.arguments.text;
  if (typeof maybeText !== "string" || !maybeText.trim()) {
    return text;
  }

  // Only unwrap when the entire response is effectively a single JSON tool call.
  const trimmed = text.trim();
  const asLooseJson = parseLooseJsonObject(trimmed);
  if (!asLooseJson) {
    return text;
  }
  return maybeText;
}

function isUnknownToolResult(result: string): boolean {
  return /^Unknown tool:/i.test(result.trim());
}

function ensureLearningFiles(): void {
  if (!existsSync(SENGIKU_DIR)) {
    mkdirSync(SENGIKU_DIR, { recursive: true });
  }

  if (!existsSync(SENGIKU_RULES_FILE)) {
    writeFileSync(
      SENGIKU_RULES_FILE,
      [
        "# Sengiku Project Rules",
        "",
        "- Prioritize tool execution for file/command requests.",
        "- Keep changes minimal, readable, and testable.",
        "- Prefer workspace-local paths and safe commands.",
        "",
      ].join("\n")
    );
  }

  if (!existsSync(SENGIKU_MEMORY_FILE)) {
    const initialMemory: LearningMemory = {
      projectGoal: "Build a reliable local coding CLI agent.",
      codingStyle: ["TypeScript strict", "small functions", "clear error messages"],
      preferredCommands: ["bun run typecheck", "bun run index.ts"],
      frequentTools: [],
      lastActive: new Date().toISOString(),
      preferredWorkflow: "tool-first execution with iterative follow-up",
    };
    writeFileSync(SENGIKU_MEMORY_FILE, JSON.stringify(initialMemory, null, 2));
  }
}

function getLearningContext(): string {
  const parts: string[] = [];
  try {
    if (existsSync(SENGIKU_RULES_FILE)) {
      const rules = readFileSync(SENGIKU_RULES_FILE, "utf8").trim();
      if (rules) {
        parts.push(`Project rules:\n${rules}`);
      }
    }

    if (existsSync(SENGIKU_MEMORY_FILE)) {
      const raw = readFileSync(SENGIKU_MEMORY_FILE, "utf8");
      const memory = JSON.parse(raw) as LearningMemory;
      parts.push(
        [
          "Project memory:",
          `- Goal: ${memory.projectGoal}`,
          `- Coding style: ${(memory.codingStyle || []).join(", ")}`,
          `- Preferred commands: ${(memory.preferredCommands || []).join(", ")}`,
          `- Frequent tools: ${(memory.frequentTools || []).join(", ")}`,
          `- Preferred workflow: ${memory.preferredWorkflow || "n/a"}`,
        ].join("\n")
      );
    }
  } catch {
    return "";
  }

  return parts.join("\n\n").trim();
}

type ToolsExposureMode = "auto" | "always" | "never";

function getToolsExposureMode(): ToolsExposureMode {
  const raw = (process.env.SENGIKU_TOOLS_MODE || "auto").toLowerCase();
  if (raw === "always" || raw === "never") {
    return raw;
  }
  return "auto";
}

/** Native tools + action-style follow-ups (fallback JSON tools, enforcement, quality gate). */
function isActionCapableTurn(input: string): boolean {
  if (isCasualGreeting(input)) {
    return false;
  }
  const mode = getToolsExposureMode();
  if (mode === "always") {
    return true;
  }
  if (mode === "never") {
    return false;
  }
  return isLikelyActionRequest(input);
}

function buildModelInput(userInput: string): string {
  if (isCasualGreeting(userInput)) {
    return [
      "Casual chat mode:",
      "- Respond naturally and briefly.",
      "- Do not call tools.",
      "",
      `User message: ${userInput}`,
    ].join("\n");
  }

  const mode = getToolsExposureMode();
  if (mode === "never") {
    return [
      "Casual chat mode:",
      "- Respond naturally and briefly.",
      "- Do not force project/task framing.",
      "- Ask follow-up only when user asks for help.",
      "",
      `User message: ${userInput}`,
    ].join("\n");
  }

  if (mode === "always") {
    const ctx = getLearningContext();
    if (!ctx) {
      return userInput;
    }
    return [
      "Use this project context before answering:",
      ctx,
      "",
      `User request: ${userInput}`,
    ].join("\n");
  }

  if (!isLikelyActionRequest(userInput)) {
    return [
      "Casual chat mode:",
      "- Respond naturally and briefly.",
      "- Do not force project/task framing.",
      "- Ask follow-up only when user asks for help.",
      "",
      `User message: ${userInput}`,
    ].join("\n");
  }

  const ctx = getLearningContext();
  if (!ctx) {
    return userInput;
  }

  return [
    "Use this project context before answering:",
    ctx,
    "",
    `User request: ${userInput}`,
  ].join("\n");
}

function isLikelyActionRequest(input: string): boolean {
  return /buat|baca|ganti|hapus|perbaiki|cek|lihat|tambah|ubah|create|edit|change|update|delete|remove|fix|replace|refactor|rename|patch|migrate|add|brand|read|check|write|run|jalankan|install|folder|file|command|bash|commit|push|pakai|use|tool|status|diff|log|branch|\.(html?|tsx?|jsx?|css|json|md|py|rs|go)\b/i.test(
    input
  );
}

function isCasualGreeting(input: string): boolean {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[!?.,]+$/g, "");
  return /^(halo|hai|hi|hello|pagi|siang|sore|malam|apa kabar|gimana kabar|yo|bro|sis|hey)$/.test(
    normalized
  );
}

function extractRequestedTargetDir(input: string): string | null {
  const absolutePathMatch = input.match(/(\/[^\s]+)/);
  if (absolutePathMatch && absolutePathMatch[1]) {
    const raw = absolutePathMatch[1].replace(/[.,]$/, "");
    const localCandidate = path.join(process.cwd(), raw.replace(/^\/+/, ""));
    if (existsSync(localCandidate)) {
      return localCandidate;
    }
    return raw;
  }

  const newFolderMatch = input.match(/folder baru(?: bernama)?\s+([A-Za-z0-9._-]+)/i);
  if (newFolderMatch && newFolderMatch[1]) {
    return path.join(process.cwd(), newFolderMatch[1]);
  }

  const folderMatch = input.match(/(?:di\s+)?folder\s+([A-Za-z0-9._/-]+)/i);
  if (folderMatch && folderMatch[1]) {
    const raw = folderMatch[1].replace(/[.,]$/, "");
    if (raw.startsWith("/")) {
      const localCandidate = path.join(process.cwd(), raw.replace(/^\/+/, ""));
      if (existsSync(localCandidate)) {
        return localCandidate;
      }
      return raw;
    }
    return path.join(process.cwd(), raw);
  }

  return null;
}

function isWriteOutsideRequestedTarget(
  call: TextToolCall,
  requestedTargetDir: string | null
): boolean {
  if (!requestedTargetDir) {
    return false;
  }
  if (call.name !== "write_file" && call.name !== "edit_file") {
    return false;
  }
  const rawPath = typeof call.arguments.path === "string" ? call.arguments.path : "";
  if (!rawPath) {
    return false;
  }
  const resolvedTarget = path.resolve(requestedTargetDir);
  const resolvedWritePath = path.resolve(process.cwd(), rawPath);
  const relative = path.relative(resolvedTarget, resolvedWritePath);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

function looksLikeToolAvoidanceResponse(text: string): boolean {
  return /tidak memiliki akses|cannot access|can't access|cannot directly|salin dan tempel|copy and paste/i.test(
    text
  );
}

function isLikelyIndonesian(input: string): boolean {
  return /\b(aku|gue|gua|gw|lu|kamu|gak|ga|nggak|enggak|bisa|tolong|coba|udah|belum|kenapa|gimana|apa|yang)\b/i.test(
    input
  );
}

function looksLikeLanguageRefusalResponse(text: string): boolean {
  return /don't understand the language|do not understand the language|please repeat.*english|could you.*english|hanya bisa bahasa inggris|english only/i.test(
    text
  );
}

function stripToolMarkers(text: string): string {
  return text
    .replace(/\[TOOL:[^\]]*\]/g, "")
    .replace(/\[RESULT:[\s\S]*?\](?=\[TOOL:|$)/g, "")
    .replace(/\[RESULT:[\s\S]*$/g, "")
    .replace(/<\|begin_of_box\|>[\s\S]*?<\/tool_call>/gi, "")
    .trim();
}

function shouldRunQualityGate(userInput: string): boolean {
  const isDirectoryInspection =
    /\b(cek|check|lihat|list|isi)\b[\s\S]*\b(folder|direktori|directory|dir)\b/i.test(
      userInput
    ) || /\bcek\b[\s\S]*\bapi\/?\b/i.test(userInput);
  if (isDirectoryInspection) {
    return false;
  }
  return /\b(build|setup|buat|create|implement|refactor|fix|write|ubah|edit|generate|crud|hono|typescript)\b/i.test(
    userInput
  );
}

function wasLoopGuardTriggered(text: string): boolean {
  return /Stopped repeated (identical tool calls|invalid tool arguments)/i.test(text);
}

function extractListDirPathHint(input: string): string | null {
  const absolutePathMatch = input.match(/(\/[^\s,]+)/);
  if (absolutePathMatch && absolutePathMatch[1]) {
    return absolutePathMatch[1].replace(/[.,]$/, "");
  }
  const slashPathMatch = input.match(/\s(\/[a-zA-Z0-9._/-]+)/);
  if (slashPathMatch && slashPathMatch[1]) {
    return slashPathMatch[1].replace(/[.,]$/, "");
  }
  const folderNameMatch = input.match(/folder\s+([a-zA-Z0-9._-]+)/i);
  if (folderNameMatch && folderNameMatch[1]) {
    return folderNameMatch[1];
  }
  return null;
}

function isInvalidToolInputResult(result: string): boolean {
  return /Invalid .* input: Missing required field:/i.test(result);
}

function isExitPromptError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "ExitPromptError" || error.message.includes("User force closed the prompt");
}

function getReadableError(error: unknown): string {
  const provider = process.env.PROVIDER || "anthropic";
  const message = error instanceof Error ? error.message : String(error);

  if (provider === "openai-compat" || provider === "ollama") {
    const baseURL =
      provider === "ollama"
        ? process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1"
        : process.env.OPENAI_BASE_URL || "";
    return formatOpenAICompatConnectionError(error, baseURL);
  }

  if (message.includes("credit balance is too low")) {
    return "Anthropic API credit kamu tidak cukup. Top up dulu di Plans & Billing, lalu coba lagi.";
  }

  if (message.includes("invalid x-api-key") || message.includes("authentication")) {
    return "API key Anthropic tidak valid. Cek `ANTHROPIC_API_KEY` di file `.env`.";
  }

  if (message.includes("connection refused")) {
    return "Connection failed. Check OPENAI_BASE_URL atau server mu.";
  }

  return `Request gagal: ${message}`;
}

function getContext() {
  const provider = process.env.PROVIDER || "anthropic";
  const model =
    provider === "ollama"
      ? process.env.OLLAMA_MODEL || "llama3.2"
      : provider === "openai-compat"
        ? process.env.OPENAI_MODEL || "mistral"
        : process.env.ANTHROPIC_MODEL || "claude-haiku";

  return { provider, model, cwd: process.cwd() };
}

async function main() {
  ensureLearningFiles();
  const sessionId = getSessionId();
  let sessionPermissionMode: PermissionMode = "default";
  const context = getContext();
  printHeader(context);


  while (true) {
    printChatDivider();
    printPromptFooter();
    const { input } = await inquirer.prompt([
      {
        type: "input",
        name: "input",
        message: promptSymbol(),
        default: "",
      },
    ]);

    if (!input.trim()) {
      continue;
    }
    const normalizedInput = normalizeShorthandWorkspacePath(input.trim());

    const suggestions = autoSuggest(normalizedInput);
    if (isLikelyActionRequest(normalizedInput) && suggestions.length > 0) {
      console.log(colors.dim(`Suggested tools: ${suggestions.join(", ")}`));
    }


    if (isCommand(normalizedInput)) {
      const result = await handleCommand(normalizedInput, messages);
      if (result.message) {
        console.log(result.message);
      }

      if (result.type === "clear") {
        messages.length = 0;
        console.log();
        continue;
      }

      if (result.type === "exit") {
        process.exit(0);
      }

      if (result.type === "mode") {
        const mode = result.meta?.mode;
        if (mode === "plan") {
          sessionPermissionMode = "plan";
        } else if (mode === "review") {
          sessionPermissionMode = "plan";
        } else if (mode === "execute") {
          sessionPermissionMode = "auto";
        }
      }

      continue;
    }

    const modelInput = buildModelInput(normalizedInput);
    const toolsForTurn: GenericTool[] | undefined = isActionCapableTurn(normalizedInput)
      ? undefined
      : [];
    const requestedTargetDir = extractRequestedTargetDir(normalizedInput);
    const controller = new AbortController();
    const correlationId = getCorrelationId();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    messages.push({
      role: "user",
      content: modelInput,
    });


    let fullResponse = "";
    let currentToolCall: { name: string; input: Record<string, unknown> } | null = null;
    const toolStartTime = Date.now();
    let hasPrintedToolSection = false;
    let executedAnyTool = false;
    let languageRetryDone = false;
    let consecutiveInvalidToolCalls = 0;
    const executedToolEvents: ExecutedToolEvent[] = [];

    startStickyLoading("Thinking");

    try {
      for await (const token of streamResponse(messages, toolsForTurn, {
        signal: controller.signal,
        sessionId,
        correlationId,
        permissionMode: sessionPermissionMode,
      })) {

        if (token.startsWith("[TOOL:")) {
          stopStickyLoading();
          const match = token.match(/\[TOOL:([^:]+):(.+)\]/);
          if (match && match.length > 2) {
            const name = match[1] || "";
            const inputStr = match[2] || "";
            try {
              if (!hasPrintedToolSection) {
                printToolSectionHeader();
                hasPrintedToolSection = true;
              }
              currentToolCall = { name, input: JSON.parse(inputStr) };
              printToolCall(name, currentToolCall.input);
            } catch {

            }
          }
          continue;
        }

        if (token.startsWith("[RESULT:")) {
          const result = token.substring("[RESULT:".length).replace(/\]$/, "");
          if (currentToolCall) {
            const timeMs = Date.now() - toolStartTime;
            printToolResult(currentToolCall.name, result, timeMs);
            executedAnyTool = true;
            executedToolEvents.push({
              toolName: currentToolCall.name,
              input: currentToolCall.input,
              result,
            });
            currentToolCall = null;
          }
          continue;
        }


        fullResponse += token;
      }

      stopStickyLoading();
      let assistantText = unwrapEchoToolTextResponse(stripToolMarkers(fullResponse));
      let fallbackRound = 0;
      const maxFallbackRounds = 5;

      while (true) {
        assistantText = unwrapEchoToolTextResponse(stripToolMarkers(assistantText));
        const textToolCalls = extractTextToolCalls(assistantText).filter(
          (call) => !isNoOpTextToolCall(call)
        );
        messages.push({
          role: "assistant",
          content: assistantText,
        });

        if (textToolCalls.length === 0) {
          console.log(renderMarkdown(assistantText));
          printChatDivider();
          console.log();
          break;
        }

        if (getToolsExposureMode() === "never") {
          console.log(renderMarkdown(assistantText));
          printChatDivider();
          console.log();
          break;
        }

        if (fallbackRound === 0) {
          if (!hasPrintedToolSection) {
            printToolSectionHeader();
            hasPrintedToolSection = true;
          }
          console.log(colors.dim("Detected textual tool calls, running fallback."));
          updateStickyLoading("Running fallback tools");
        }

        let unknownToolDetected = false;
        let abortFallbackLoop = false;
        for (const rawCall of textToolCalls) {
          const call = normalizeToolCallAlias(rawCall);
          if (
            call.name === "list_dir" &&
            typeof call.arguments.path !== "string"
          ) {
            const hintPath = extractListDirPathHint(normalizedInput);
            if (hintPath) {
              call.arguments = { ...call.arguments, path: hintPath };
            }
          }
          if (isWriteOutsideRequestedTarget(call, requestedTargetDir)) {
            const target = requestedTargetDir || "(unknown)";
            const blockedPath =
              typeof call.arguments.path === "string" ? call.arguments.path : "(unknown)";
            const blockMessage = `Blocked ${call.name} outside requested target (${target}): ${blockedPath}`;
            printToolResult(call.name, blockMessage, 0);
            messages.push({
              role: "user",
              content: `System guard: ${blockMessage}. Use only files inside requested target.`,
            });
            continue;
          }
          const startedAt = Date.now();
          if (!hasPrintedToolSection) {
            printToolSectionHeader();
            hasPrintedToolSection = true;
          }
          printToolCall(call.name, call.arguments);
          const result = await executeTool(call.name, call.arguments, {
            workspaceRoot: process.cwd(),
            permissionMode: sessionPermissionMode,
            sessionId,
            correlationId,
            signal: controller.signal,
          });
          printToolResult(call.name, result, Date.now() - startedAt);
          executedAnyTool = true;
          updateMemoryFromAnalytics();
          executedToolEvents.push({
            toolName: call.name,
            input: call.arguments,
            result,
          });

          messages.push({
            role: "user",
            content: `Tool ${call.name} returned: ${result}`,
          });
          if (isUnknownToolResult(result)) {
            unknownToolDetected = true;
          }
          if (isInvalidToolInputResult(result)) {
            consecutiveInvalidToolCalls += 1;
          } else {
            consecutiveInvalidToolCalls = 0;
          }
          if (consecutiveInvalidToolCalls >= 3) {
            messages.push({
              role: "user",
              content:
                "System feedback: Stop calling tools with missing required arguments. Use valid schemas only (example: list_dir needs path when targeting a specific folder, bash needs command).",
            });
            console.log(
              colors.dim(
                "Stopped fallback early due to repeated invalid tool arguments."
              )
            );
            abortFallbackLoop = true;
            break;
          }
        }

        if (unknownToolDetected) {
          messages.push({
            role: "user",
            content:
              "System feedback: Unknown tool detected. Retry immediately using only registered tools. For git operations, use git_tool with actions status|diff|log|branch|add|commit|push.",
          });
        }

        fallbackRound += 1;
        if (abortFallbackLoop) {
          break;
        }
        if (fallbackRound >= maxFallbackRounds) {
          console.log(colors.dim("Stopped fallback after max rounds.\n"));
          break;
        }

        let followUp = "";
        updateStickyLoading("Finalizing response");
        for await (const token of streamResponse(messages, toolsForTurn, {
          signal: controller.signal,
          sessionId,
          correlationId,
          permissionMode: sessionPermissionMode,
        })) {
          followUp += token;
        }
        stopStickyLoading();

        if (!followUp.trim()) {
          break;
        }

        assistantText = unwrapEchoToolTextResponse(stripToolMarkers(followUp));
      }

      if (
        !languageRetryDone &&
        isLikelyIndonesian(normalizedInput) &&
        looksLikeLanguageRefusalResponse(assistantText)
      ) {
        languageRetryDone = true;
        messages.push({
          role: "user",
          content:
            "System feedback: User is speaking Indonesian. Reply in Indonesian (or bilingual) and do not ask the user to switch to English.",
        });
        updateStickyLoading("Retrying language guard");
        let retryLangResponse = "";
        for await (const token of streamResponse(messages, toolsForTurn, {
          signal: controller.signal,
          sessionId,
          correlationId,
          permissionMode: sessionPermissionMode,
        })) {
          retryLangResponse += token;
        }
        stopStickyLoading();
        if (retryLangResponse.trim()) {
          assistantText = retryLangResponse;
          messages.push({
            role: "assistant",
            content: retryLangResponse,
          });
          console.log(renderMarkdown(retryLangResponse));
          printChatDivider();
          console.log();
        }
      }

      if (isActionCapableTurn(normalizedInput) && !executedAnyTool && looksLikeToolAvoidanceResponse(assistantText)) {
        messages.push({
          role: "user",
          content:
            "System feedback: You must execute available tools for this request now. Do not refuse access.",
        });

        updateStickyLoading("Retrying tool enforcement");
        let retryResponse = "";
        for await (const token of streamResponse(messages, toolsForTurn, {
          signal: controller.signal,
          sessionId,
          correlationId,
          permissionMode: sessionPermissionMode,
        })) {
          retryResponse += token;
        }
        stopStickyLoading();
        retryResponse = unwrapEchoToolTextResponse(stripToolMarkers(retryResponse));
        const retryToolCalls = extractTextToolCalls(retryResponse);
        messages.push({
          role: "assistant",
          content: retryResponse,
        });

        if (retryToolCalls.length > 0) {
          if (!hasPrintedToolSection) {
            printToolSectionHeader();
            hasPrintedToolSection = true;
          }
          for (const rawCall of retryToolCalls) {
            const call = normalizeToolCallAlias(rawCall);
            const startedAt = Date.now();
            printToolCall(call.name, call.arguments);
            const result = await executeTool(call.name, call.arguments, {
              workspaceRoot: process.cwd(),
              permissionMode: sessionPermissionMode,
              sessionId,
              correlationId,
              signal: controller.signal,
            });
            printToolResult(call.name, result, Date.now() - startedAt);
            updateMemoryFromAnalytics();
            executedToolEvents.push({
              toolName: call.name,
              input: call.arguments,
              result,
            });
            messages.push({
              role: "user",
              content: `Tool ${call.name} returned: ${result}`,
            });
          }
        } else {
          console.log(renderMarkdown(retryResponse));
          printChatDivider();
          console.log();
        }
      }

      if (
        isActionCapableTurn(normalizedInput) &&
        shouldRunQualityGate(normalizedInput) &&
        executedToolEvents.length > 0 &&
        !wasLoopGuardTriggered(assistantText)
      ) {
        const gateFeedback = evaluateToolExecution(normalizedInput, executedToolEvents);
        if (gateFeedback) {
          messages.push({
            role: "user",
            content: `System quality gate: ${gateFeedback}`,
          });

          updateStickyLoading("Applying quality checks");
          let gatedResponse = "";
          for await (const token of streamResponse(messages, toolsForTurn, {
            signal: controller.signal,
            sessionId,
            correlationId,
            permissionMode: sessionPermissionMode,
          })) {
            gatedResponse += token;
          }
          stopStickyLoading();
          gatedResponse = unwrapEchoToolTextResponse(stripToolMarkers(gatedResponse));

          if (gatedResponse.trim()) {
            messages.push({
              role: "assistant",
              content: gatedResponse,
            });
            console.log(renderMarkdown(gatedResponse));
            printChatDivider();
            console.log();
          }
        }
      }
    } catch (error) {
      stopStickyLoading();
      console.log(colors.error(`\n${getReadableError(error)}\n`));

      if (messages[messages.length - 1]?.role === "user") {
        messages.pop();
      }
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  }
}

main().catch((error) => {
  analytics.flush();
  if (isExitPromptError(error)) {
    stopStickyLoading();
    console.log(colors.dim("\nBye!\n"));
    process.exit(0);
  }

  console.error(error);
  process.exit(1);
});

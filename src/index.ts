import inquirer from "inquirer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GenericMessage } from "./providers/base";
import { streamResponse } from "./client";
import {
  colors,
  spinner,
  printHeader,
  printChatDivider,
  printToolSectionHeader,
  printToolCall,
  printToolResult,
  renderMarkdown,
  promptSymbol,
} from "./ui";
import { isCommand, handleCommand } from "./commands/registry";
import { executeTool } from "./tools/registry";
import { autoSuggest } from "./suggestions";
import { analytics } from "./analytics";
import type { PermissionMode } from "./tools/base";
import { evaluateToolExecution, type ExecutedToolEvent } from "./quality-gate";

const messages: GenericMessage[] = [];
const SENGIKU_DIR = path.join(process.cwd(), ".sengiku");
const SENGIKU_RULES_FILE = path.join(SENGIKU_DIR, "rules.md");
const SENGIKU_MEMORY_FILE = path.join(SENGIKU_DIR, "memory.json");

type TextToolCall = { name: string; arguments: Record<string, unknown> };
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
    const normalized = trimmed
      .replace(/'/g, "\"")
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');

    try {
      return JSON.parse(normalized) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function collectObjectLikeSnippets(text: string): string[] {
  const snippets = new Set<string>();


  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      snippets.add(trimmed);
    }
  }


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

  return calls;
}

function isNoOpTextToolCall(call: TextToolCall): boolean {
  if (call.name === "echo_tool") {
    return true;
  }
  return false;
}

function normalizeTextToolCall(call: TextToolCall): TextToolCall {
  const name = call.name.trim().toLowerCase();
  if (name === "git_log") {
    return {
      name: "git_tool",
      arguments: { ...call.arguments, action: "log" },
    };
  }
  if (name === "git_status") {
    return {
      name: "git_tool",
      arguments: { ...call.arguments, action: "status" },
    };
  }
  if (name === "git_diff") {
    return {
      name: "git_tool",
      arguments: { ...call.arguments, action: "diff" },
    };
  }
  if (name === "git_branch") {
    return {
      name: "git_tool",
      arguments: { ...call.arguments, action: "branch" },
    };
  }
  return call;
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

function buildModelInput(userInput: string): string {
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
  return /buat|create|edit|ubah|write|run|jalankan|install|folder|file|command|bash|commit|push|pakai|use|tool|status|diff|log|branch/i.test(
    input
  );
}

function extractRequestedTargetDir(input: string): string | null {
  const absolutePathMatch = input.match(/(\/[^\s]+)/);
  if (absolutePathMatch && absolutePathMatch[1]) {
    return absolutePathMatch[1].replace(/[.,]$/, "");
  }

  const newFolderMatch = input.match(/folder baru(?: bernama)?\s+([A-Za-z0-9._-]+)/i);
  if (newFolderMatch && newFolderMatch[1]) {
    return path.join(process.cwd(), newFolderMatch[1]);
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

function isExitPromptError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "ExitPromptError" || error.message.includes("User force closed the prompt");
}

function getReadableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("credit balance is too low")) {
    return "Anthropic API credit kamu tidak cukup. Top up dulu di Plans & Billing, lalu coba lagi.";
  }

  if (message.includes("invalid x-api-key") || message.includes("authentication")) {
    return "API key Anthropic tidak valid. Cek `ANTHROPIC_API_KEY` di file `.env`.";
  }

  if (message.includes("connection refused")) {
    const provider = process.env.PROVIDER || "anthropic";
    if (provider === "ollama") {
      return "Ollama server tidak jalan. Jalankan `ollama serve` di terminal lain.";
    }
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
  const sessionPermissionMode: PermissionMode = "default";
  const context = getContext();
  printHeader(context);


  while (true) {
    printChatDivider();
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

    const suggestions = autoSuggest(input);
    if (isLikelyActionRequest(input) && suggestions.length > 0) {
      console.log(colors.dim(`Suggested tools: ${suggestions.join(", ")}`));
    }


    if (isCommand(input)) {
      const result = await handleCommand(input, messages);
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

      continue;
    }


    const modelInput = buildModelInput(input);
    const requestedTargetDir = extractRequestedTargetDir(input);
    const controller = new AbortController();
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
    const executedToolEvents: ExecutedToolEvent[] = [];

    spinner.start("Thinking...");

    try {
      for await (const token of streamResponse(messages, undefined, {
        signal: controller.signal,
        sessionId,
        permissionMode: sessionPermissionMode,
      })) {

        if (token.startsWith("[TOOL:")) {
          spinner.stop();
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

      spinner.stop();
      let assistantText = fullResponse;
      let fallbackRound = 0;
      const maxFallbackRounds = 5;

      while (true) {
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

        if (!isLikelyActionRequest(input)) {
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
        }

        let unknownToolDetected = false;
        for (const rawCall of textToolCalls) {
          const call = normalizeTextToolCall(rawCall);
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
        }

        if (unknownToolDetected) {
          messages.push({
            role: "user",
            content:
              "System feedback: Unknown tool detected. Retry immediately using only registered tools. For git operations, use git_tool with actions status|diff|log|branch|add|commit|push.",
          });
        }

        fallbackRound += 1;
        if (fallbackRound >= maxFallbackRounds) {
          console.log(colors.dim("Stopped fallback after max rounds.\n"));
          break;
        }

        let followUp = "";
        spinner.start("Finalizing...");
        for await (const token of streamResponse(messages, undefined, {
          signal: controller.signal,
          sessionId,
          permissionMode: sessionPermissionMode,
        })) {
          followUp += token;
        }
        spinner.stop();

        if (!followUp.trim()) {
          break;
        }

        assistantText = followUp;
      }

      if (isLikelyActionRequest(input) && !executedAnyTool && looksLikeToolAvoidanceResponse(assistantText)) {
        messages.push({
          role: "user",
          content:
            "System feedback: You must execute available tools for this request now. Do not refuse access.",
        });

        spinner.start("Retrying with tool enforcement...");
        let retryResponse = "";
        for await (const token of streamResponse(messages, undefined, {
          signal: controller.signal,
          sessionId,
          permissionMode: sessionPermissionMode,
        })) {
          retryResponse += token;
        }
        spinner.stop();
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
            const call = normalizeTextToolCall(rawCall);
            const startedAt = Date.now();
            printToolCall(call.name, call.arguments);
            const result = await executeTool(call.name, call.arguments, {
              workspaceRoot: process.cwd(),
              permissionMode: sessionPermissionMode,
              sessionId,
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

      if (isLikelyActionRequest(input) && executedToolEvents.length > 0) {
        const gateFeedback = evaluateToolExecution(input, executedToolEvents);
        if (gateFeedback) {
          messages.push({
            role: "user",
            content: `System quality gate: ${gateFeedback}`,
          });

          spinner.start("Applying quality gate feedback...");
          let gatedResponse = "";
          for await (const token of streamResponse(messages, undefined, {
            signal: controller.signal,
            sessionId,
            permissionMode: sessionPermissionMode,
          })) {
            gatedResponse += token;
          }
          spinner.stop();

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
      spinner.stop();
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
    spinner.stop();
    console.log(colors.dim("\nBye!\n"));
    process.exit(0);
  }

  console.error(error);
  process.exit(1);
});

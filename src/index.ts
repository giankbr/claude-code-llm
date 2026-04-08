import inquirer from "inquirer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GenericMessage } from "./providers/base";
import { streamResponse } from "./client";
import {
  colors,
  spinner,
  printHeader,
  printToolSectionHeader,
  printToolCall,
  printToolResult,
  renderMarkdown,
  promptSymbol,
} from "./ui";
import { isCommand, handleCommand } from "./commands/registry";
import { executeTool } from "./tools/registry";

const messages: GenericMessage[] = [];
const SENGIKU_DIR = path.join(process.cwd(), ".sengiku");
const SENGIKU_RULES_FILE = path.join(SENGIKU_DIR, "rules.md");
const SENGIKU_MEMORY_FILE = path.join(SENGIKU_DIR, "memory.json");

type TextToolCall = { name: string; arguments: Record<string, unknown> };
type LearningMemory = {
  projectGoal: string;
  codingStyle: string[];
  preferredCommands: string[];
};

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
        ].join("\n")
      );
    }
  } catch {
    return "";
  }

  return parts.join("\n\n").trim();
}

function buildModelInput(userInput: string): string {
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
  return /buat|create|edit|ubah|write|run|jalankan|install|folder|file|command|bash|commit|push/i.test(
    input
  );
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
  const context = getContext();
  printHeader(context);


  while (true) {
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
    messages.push({
      role: "user",
      content: modelInput,
    });


    let fullResponse = "";
    let currentToolCall: { name: string; input: Record<string, unknown> } | null = null;
    const toolStartTime = Date.now();
    let hasPrintedToolSection = false;
    let executedAnyTool = false;

    spinner.start("Thinking...");

    try {
      for await (const token of streamResponse(messages)) {

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
        const textToolCalls = extractTextToolCalls(assistantText);
        messages.push({
          role: "assistant",
          content: assistantText,
        });

        if (textToolCalls.length === 0) {
          console.log(renderMarkdown(assistantText));
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

        for (const call of textToolCalls) {
          const startedAt = Date.now();
          if (!hasPrintedToolSection) {
            printToolSectionHeader();
            hasPrintedToolSection = true;
          }
          printToolCall(call.name, call.arguments);
          const result = await executeTool(call.name, call.arguments);
          printToolResult(call.name, result, Date.now() - startedAt);
          executedAnyTool = true;

          messages.push({
            role: "user",
            content: `Tool ${call.name} returned: ${result}`,
          });
        }

        fallbackRound += 1;
        if (fallbackRound >= maxFallbackRounds) {
          console.log(colors.dim("Stopped fallback after max rounds.\n"));
          break;
        }

        let followUp = "";
        spinner.start("Finalizing...");
        for await (const token of streamResponse(messages)) {
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
        for await (const token of streamResponse(messages)) {
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
          for (const call of retryToolCalls) {
            const startedAt = Date.now();
            printToolCall(call.name, call.arguments);
            const result = await executeTool(call.name, call.arguments);
            printToolResult(call.name, result, Date.now() - startedAt);
            messages.push({
              role: "user",
              content: `Tool ${call.name} returned: ${result}`,
            });
          }
        } else {
          console.log(renderMarkdown(retryResponse));
          console.log();
        }
      }
    } catch (error) {
      spinner.stop();
      console.log(colors.error(`\n${getReadableError(error)}\n`));

      if (messages[messages.length - 1]?.role === "user") {
        messages.pop();
      }
    }
  }
}

main().catch((error) => {
  if (isExitPromptError(error)) {
    spinner.stop();
    console.log(colors.dim("\nBye!\n"));
    process.exit(0);
  }

  console.error(error);
  process.exit(1);
});

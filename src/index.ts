import inquirer from "inquirer";
import type { GenericMessage } from "./providers/base";
import { streamResponse } from "./client";
import {
  colors,
  spinner,
  printHeader,
  printToolCall,
  printToolResult,
  renderMarkdown,
  promptSymbol,
} from "./ui";
import { isCommand, handleCommand } from "./commands";
import { executeTool } from "./tools";

const messages: GenericMessage[] = [];

type TextToolCall = { name: string; arguments: Record<string, unknown> };

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


    messages.push({
      role: "user",
      content: input,
    });


    let fullResponse = "";
    let currentToolCall: { name: string; input: Record<string, unknown> } | null = null;
    const toolStartTime = Date.now();

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
          console.log(
            colors.dim("Detected textual tool calls from model, executing fallback...\n")
          );
        }

        for (const call of textToolCalls) {
          const startedAt = Date.now();
          printToolCall(call.name, call.arguments);
          const result = await executeTool(call.name, call.arguments);
          printToolResult(call.name, result, Date.now() - startedAt);

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

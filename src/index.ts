import inquirer from "inquirer";
import type { GenericMessage } from "./providers/base";
import { streamResponse } from "./client";
import { colors, spinner, printHeader, printLabel, printToolCall, printToolResult, renderMarkdown } from "./ui";
import { isCommand, handleCommand } from "./commands";

const messages: GenericMessage[] = [];

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

async function main() {
  printHeader();
  console.log(colors.dim("Type /help for commands, /exit to quit\n"));

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { input } = await inquirer.prompt([
      {
        type: "input",
        name: "input",
        message: colors.user(">"),
        default: "",
      },
    ]);

    if (!input.trim()) {
      continue;
    }

    // Check for slash commands
    if (isCommand(input)) {
      const result = handleCommand(input, messages);
      if (result.message) {
        console.log(result.message);
      }

      if (result.type === "clear") {
        messages.length = 0;
        continue;
      }

      if (result.type === "exit") {
        process.exit(0);
      }

      continue;
    }

    // Print human label and input
    printLabel("Human");
    console.log(input);
    console.log();

    // Add user message to history
    messages.push({
      role: "user",
      content: input,
    });

    // Stream response
    let fullResponse = "";
    let currentToolCall: { name: string; input: Record<string, unknown> } | null = null;

    spinner.start();

    try {
      for await (const token of streamResponse(messages)) {
        // Check for tool call markers
        if (token.startsWith("[TOOL:")) {
          const match = token.match(/\[TOOL:([^:]+):(.+)\]/);
          if (match && match.length > 2) {
            const name = match[1] || "";
            const inputStr = match[2] || "";
            try {
              currentToolCall = { name, input: JSON.parse(inputStr) };
            } catch {
              // Skip if JSON parse fails
            }
          }
          continue;
        }

        if (token.startsWith("[RESULT:")) {
          const result = token.substring("[RESULT:".length).replace(/\]$/, "");
          if (currentToolCall) {
            printToolCall(currentToolCall.name, currentToolCall.input);
            printToolResult(result);
            currentToolCall = null;
          }
          continue;
        }

        // Accumulate response text
        fullResponse += token;
      }

      spinner.stop();

      // Print rendered markdown response
      printLabel("Assistant");
      console.log(renderMarkdown(fullResponse));

      // Add assistant response to messages
      messages.push({
        role: "assistant",
        content: fullResponse,
      });
    } catch (error) {
      spinner.stop();
      console.log(colors.error(`\n${getReadableError(error)}\n`));
      // Remove the user message if there was an error
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

import inquirer from "inquirer";
import type { GenericMessage } from "./providers/base";
import { streamResponse } from "./client";
import { colors, spinner } from "./ui";
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

  return `Request gagal: ${message}`;
}

async function main() {
  console.log(colors.dim("Sengiku AI CLI"));
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

    // Add user message to history
    messages.push({
      role: "user",
      content: input,
    });

    // Stream response
    let firstToken = true;
    spinner.start();

    try {
      for await (const token of streamResponse(messages)) {
        if (firstToken) {
          spinner.stop();
          firstToken = false;
        }
        process.stdout.write(colors.assistant(token));
      }

      if (firstToken) {
        spinner.stop();
      }

      console.log("\n");
    } catch (error) {
      spinner.stop();
      console.log(colors.error(`\n${getReadableError(error)}\n`));
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

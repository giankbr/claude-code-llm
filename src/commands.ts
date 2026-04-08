import type { GenericMessage } from "./providers/base";
import { colors } from "./ui";

export type CommandResult = {
  type: "clear" | "help" | "exit" | "unknown";
  message?: string;
};

export function isCommand(input: string): boolean {
  return input.trim().startsWith("/");
}

export function handleCommand(
  input: string,
  _messages: GenericMessage[]
): CommandResult {
  const command = input.trim().toLowerCase();

  if (command === "/clear") {
    return {
      type: "clear",
      message: colors.dim("Conversation history cleared."),
    };
  }

  if (command === "/help") {
    return {
      type: "help",
      message: `
${colors.dim("Available commands:")}
  /help   - Show this message
  /clear  - Clear conversation history
  /exit   - Exit the REPL
      `.trim(),
    };
  }

  if (command === "/exit") {
    return {
      type: "exit",
      message: colors.dim("Goodbye!"),
    };
  }

  return {
    type: "unknown",
    message: colors.error(`Unknown command: ${command}`),
  };
}

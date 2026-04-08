import type { Command } from "./base";
import { colors } from "../ui";

export const helpCommand: Command = {
  name: "help",
  aliases: ["?"],
  description: "Show available commands",
  async handler() {
    return {
      type: "help",
      message: `
${colors.dim("Available commands:")}
  /help   - Show this message
  /clear  - Clear conversation history
  /tools  - List available tools
  /memory - Show/edit project memory
  /doctor - Check runtime/provider/tooling health
  /exit   - Exit the REPL
      `.trim(),
    };
  },
};

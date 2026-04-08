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
  /help      - Show this message
  /clear     - Clear conversation history
  /tools     - List available tools
  /plugins   - Manage plugins (list/install/remove/manifest:refresh)
  /mode      - Set mode (plan/execute/review)
  /init      - Create default SENGIKU.md file
  /docs      - Show tool documentation (run '/docs <tool>' or '/docs' for all)
  /memory    - Show/edit project memory
  /analytics - Show tool usage analytics
  /config    - Configure Sengiku Code (permissions, settings)
  /doctor    - Check runtime/provider/tooling health
  /exit      - Exit the REPL
      `.trim(),
    };
  },
};

import type { Command } from "./base";

export const exitCommand: Command = {
  name: "exit",
  aliases: ["quit"],
  description: "Exit the REPL",
  async handler() {
    return {
      type: "exit",
    };
  },
};

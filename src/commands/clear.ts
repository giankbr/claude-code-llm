import type { Command } from "./base";
import { colors } from "../ui";

export const clearCommand: Command = {
  name: "clear",
  description: "Clear conversation history",
  async handler() {
    return {
      type: "clear",
      message: colors.dim("Conversation history cleared."),
    };
  },
};

import type { Command } from "./base";
import { colors } from "../ui";

const ALLOWED = new Set(["plan", "execute", "review"]);

export const modeCommand: Command = {
  name: "mode",
  description: "Set session mode (plan/execute/review)",
  async handler(args) {
    const next = args.trim().toLowerCase();
    if (!next || !ALLOWED.has(next)) {
      return {
        type: "mode",
        message: `${colors.error("Invalid mode.")} Use /mode plan|execute|review`,
      };
    }
    return {
      type: "mode",
      message: `${colors.success("✓")} Mode set to ${next}`,
      meta: { mode: next },
    };
  },
};


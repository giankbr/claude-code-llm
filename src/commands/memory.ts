import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Command } from "./base";
import { colors } from "../ui";

export const memoryCommand: Command = {
  name: "memory",
  description: "Show project memory",
  async handler() {
    const SENGIKU_DIR = path.join(process.cwd(), ".sengiku");
    const SENGIKU_MEMORY_FILE = path.join(SENGIKU_DIR, "memory.json");

    if (!existsSync(SENGIKU_MEMORY_FILE)) {
      return {
        type: "memory",
        message: colors.dim("No memory file found yet."),
      };
    }

    try {
      const raw = readFileSync(SENGIKU_MEMORY_FILE, "utf8");
      const memory = JSON.parse(raw);
      const formatted = JSON.stringify(memory, null, 2);
      return {
        type: "memory",
        message: `${colors.dim("Project memory:")} \n${formatted}`,
      };
    } catch (e) {
      return {
        type: "memory",
        message: colors.error(
          `Error reading memory: ${e instanceof Error ? e.message : String(e)}`
        ),
      };
    }
  },
};

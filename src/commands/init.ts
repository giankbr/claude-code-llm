import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "./base";
import { colors } from "../ui";

const DEFAULT_SENGIKU_MD = [
  "# SENGIKU.md",
  "",
  "Project instructions for AI coding assistants.",
  "",
  "## Goals",
  "- Build features safely and incrementally.",
  "- Prefer readable, testable code.",
  "",
  "## Style",
  "- Keep changes minimal and focused.",
  "- Follow existing code conventions.",
  "",
  "## Workflow",
  "- Run typecheck/tests after code changes.",
  "- Explain what changed and why.",
  "",
].join("\n");

export const initCommand: Command = {
  name: "init",
  description: "Create a default SENGIKU.md instruction file",
  async handler() {
    const filePath = path.join(process.cwd(), "SENGIKU.md");
    if (existsSync(filePath)) {
      return {
        type: "init",
        message: colors.dim("SENGIKU.md already exists."),
      };
    }

    writeFileSync(filePath, DEFAULT_SENGIKU_MD, "utf8");
    return {
      type: "init",
      message: colors.success("Created SENGIKU.md"),
    };
  },
};

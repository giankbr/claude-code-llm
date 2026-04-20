import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "./base";
import { colors } from "../ui";

const DEFAULT_SENGIKU_MD = [
  "# SENGIKU.md",
  "",
  "Project instructions for AI coding assistants (e.g. Cursor, Copilot, Sengiku Code).",
  "",
  "## Project overview",
  "- One or two sentences: what this repo does and who it is for.",
  "",
  "## Stack",
  "- Language, runtime, package manager, main entry command.",
  "",
  "## Layout",
  "- Map important directories to roles (where features, tests, config live).",
  "",
  "## Conventions",
  "- Code style, naming, how to add a feature, error-handling expectations.",
  "- Security: no secrets in repo; where env vars are documented.",
  "",
  "## Verify after changes",
  "- Commands to run (typecheck, test, lint, build) — copy from this project’s `package.json` scripts.",
  "",
  "## Out of scope",
  "- What assistants should not change without explicit ask (e.g. large refactors, unrelated files).",
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

import type { Command } from "./base";
import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import inquirer from "inquirer";
import { colors } from "../ui";
import { getGenericTools, initializeTools } from "../tools/registry";

export const configCommand: Command = {
  name: "config",
  aliases: ["configure"],
  description: "Configure Sengiku Code settings (permissions, etc)",
  async handler(args, _messages) {
    await initializeTools();
    const subcommand = args.trim() || "menu";

    if (subcommand === "permissions") {
      return await configurePermissions();
    } else if (subcommand === "menu") {
      return await showConfigMenu();
    } else {
      return {
        type: "unknown",
        message: colors.error(`Unknown config subcommand: ${subcommand}`),
      };
    }
  },
};

async function showConfigMenu() {
  const { choice } = await inquirer.prompt([
    {
      type: "list",
      name: "choice",
      message: "What would you like to configure?",
      choices: [
        { name: "Permissions (user role, tool overrides)", value: "permissions" },
        { name: "View current config", value: "view" },
        { name: "Cancel", value: "cancel" },
      ],
    },
  ]);

  if (choice === "permissions") {
    return await configurePermissions();
  } else if (choice === "view") {
    const fs = require("fs");
    const permissionsFile = path.join(process.cwd(), ".sengiku", "permissions.json");
    if (fs.existsSync(permissionsFile)) {
      const content = fs.readFileSync(permissionsFile, "utf8");
      return {
        type: "config" as const,
        message: `${colors.dim("Current permissions config:")}\n${content}`,
      };
    } else {
      return {
        type: "config" as const,
        message: colors.dim("No permissions config found. Run '/config permissions' to create one."),
      };
    }
  } else {
    return {
      type: "config" as const,
      message: colors.dim("Cancelled."),
    };
  }
}

async function configurePermissions() {
  const tools = getGenericTools();

  const { userRole } = await inquirer.prompt([
    {
      type: "list",
      name: "userRole",
      message: "Select your user role:",
      choices: [
        { name: "admin - full access to all tools", value: "admin" },
        { name: "editor - read + non-destructive tools", value: "editor" },
        { name: "viewer - read-only tools only", value: "viewer" },
      ],
      default: "admin",
    },
  ]);

  const { setupToolOverrides } = await inquirer.prompt([
    {
      type: "confirm",
      name: "setupToolOverrides",
      message: "Set up per-tool overrides?",
      default: false,
    },
  ]);

  let toolOverrides: Record<string, unknown>[] = [];
  if (setupToolOverrides) {
    const { selectedTools } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "selectedTools",
        message: "Which tools would you like to override?",
        choices: tools.map((t) => ({ name: t.name, value: t.name })),
      },
    ]);

    for (const toolName of selectedTools) {
      const { mode } = await inquirer.prompt([
        {
          type: "list",
          name: "mode",
          message: `Permission mode for "${toolName}":`,
          choices: [
            "plan - ask before every execution",
            "auto - auto-approve with warnings",
            "default - ask for destructive only",
            "bypassPermissions - skip all checks",
          ],
        },
      ]);

      toolOverrides.push({
        toolName,
        mode: mode.split(" ")[0],
      });
    }
  }

  const config = {
    role: userRole,
    toolOverrides: toolOverrides.length > 0 ? toolOverrides : undefined,
  };

  const permissionsFile = path.join(process.cwd(), ".sengiku", "permissions.json");
  writeFileSync(permissionsFile, JSON.stringify(config, null, 2));

  return {
    type: "config" as const,
    message: `${colors.success("✓")} Permissions config saved to ${permissionsFile}\n${colors.dim("Current role: " + userRole)}`,
  };
}

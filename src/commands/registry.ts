import type { Command, CommandResult } from "./base";
import type { GenericMessage } from "../providers/base";
import { clearCommand } from "./clear";
import { helpCommand } from "./help";
import { exitCommand } from "./exit";
import { doctorCommand } from "./doctor";
import { memoryCommand } from "./memory";
import { toolsCommand } from "./tools";
import { analyticsCommand } from "./analytics";
import { configCommand } from "./config";
import { docsCommand } from "./docs";
import { initCommand } from "./init";
import { pluginsCommand } from "./plugins";
import { modeCommand } from "./mode";
import { colors } from "../ui";

const COMMANDS: Command[] = [
  clearCommand,
  helpCommand,
  exitCommand,
  doctorCommand,
  memoryCommand,
  toolsCommand,
  analyticsCommand,
  configCommand,
  docsCommand,
  initCommand,
  pluginsCommand,
  modeCommand,
];

export function isCommand(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return false;
  }
  if (/^\/[A-Za-z0-9._-]+\/.+/.test(trimmed)) {
    return false;
  }
  return true;
}

export function findCommand(input: string): Command | undefined {
  const trimmed = input.trim().toLowerCase().substring(1);
  const parts = trimmed.split(/\s+/);
  const name = parts[0] || "";

  return COMMANDS.find(
    (cmd) => cmd.name === name || (cmd.aliases?.includes(name) ?? false)
  );
}

export async function handleCommand(
  input: string,
  messages: GenericMessage[]
): Promise<CommandResult> {
  const command = findCommand(input);

  if (!command) {
    const trimmed = input.trim().toLowerCase();
    return {
      type: "unknown",
      message: colors.error(`Unknown command: ${trimmed}`),
    };
  }

  const inputLower = input.trim().toLowerCase();
  const parts = inputLower.split(/\s+/);
  const cmdName = parts[0] || "";
  const args = input.substring(cmdName.length + 1).trim();

  return await command.handler(args, messages);
}

export function getCommandList(): Command[] {
  return COMMANDS;
}

import type { GenericMessage } from "../providers/base";

export type CommandResultType = "clear" | "help" | "exit" | "doctor" | "memory" | "tools" | "analytics" | "config" | "docs" | "init" | "plugins" | "mode" | "unknown";

export interface CommandResult {
  type: CommandResultType;
  message?: string;
  meta?: Record<string, unknown>;
}

export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  hidden?: boolean;
  handler(args: string, messages: GenericMessage[]): Promise<CommandResult>;
}

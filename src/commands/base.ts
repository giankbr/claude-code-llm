import type { GenericMessage } from "../providers/base";

export type CommandResultType = "clear" | "help" | "exit" | "doctor" | "memory" | "tools" | "unknown";

export interface CommandResult {
  type: CommandResultType;
  message?: string;
}

export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  hidden?: boolean;
  handler(args: string, messages: GenericMessage[]): Promise<CommandResult>;
}

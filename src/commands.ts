import type { GenericMessage } from "./providers/base";
import { colors } from "./ui";

export type CommandResult = {
  type: "clear" | "help" | "exit" | "doctor" | "unknown";
  message?: string;
};

export function isCommand(input: string): boolean {
  return input.trim().startsWith("/");
}

async function checkUrl(baseUrl: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(baseUrl, {
      method: "GET",
      signal: controller.signal,
    });
    return `${response.status} ${response.statusText}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unreachable (${message})`;
  } finally {
    clearTimeout(timer);
  }
}

async function buildDoctorReport(messages: GenericMessage[]): Promise<string> {
  const provider = process.env.PROVIDER || "anthropic";
  const anthropicKeySet = !!process.env.ANTHROPIC_API_KEY;
  const anthropicModel = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
  const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5-coder:7b";
  const openaiBaseUrl = process.env.OPENAI_BASE_URL || "(not set)";
  const openaiModel = process.env.OPENAI_MODEL || "(not set)";
  const promptType = process.env.SYSTEM_PROMPT_TYPE || "code";
  const cwd = process.cwd();

  let connectivityLine = "n/a";
  if (provider === "ollama") {
    connectivityLine = await checkUrl(ollamaBaseUrl);
  } else if (provider === "openai-compat" && openaiBaseUrl !== "(not set)") {
    connectivityLine = await checkUrl(openaiBaseUrl);
  } else if (provider === "anthropic") {
    connectivityLine = "remote API (not checked in /doctor)";
  }

  return `
${colors.dim("Doctor report")}
  Provider         : ${provider}
  Active model     : ${
    provider === "anthropic"
      ? anthropicModel
      : provider === "ollama"
        ? ollamaModel
        : openaiModel
  }
  System prompt    : ${promptType}
  CWD              : ${cwd}
  Message history  : ${messages.length} messages

${colors.dim("Environment")}
  ANTHROPIC_API_KEY: ${anthropicKeySet ? "set" : "missing"}
  OLLAMA_BASE_URL  : ${ollamaBaseUrl}
  OPENAI_BASE_URL  : ${openaiBaseUrl}

${colors.dim("Connectivity")}
  Provider endpoint: ${connectivityLine}

${colors.dim("Tool sandbox")}
  read_file/write_file: workspace-only
  bash               : workspace cwd + dangerous commands blocked
  `.trim();
}

export async function handleCommand(
  input: string,
  messages: GenericMessage[]
): Promise<CommandResult> {
  const command = input.trim().toLowerCase();

  if (command === "/clear") {
    return {
      type: "clear",
      message: colors.dim("Conversation history cleared."),
    };
  }

  if (command === "/help") {
    return {
      type: "help",
      message: `
${colors.dim("Available commands:")}
  /help   - Show this message
  /clear  - Clear conversation history
  /doctor - Check runtime/provider/tooling health
  /exit   - Exit the REPL
      `.trim(),
    };
  }

  if (command === "/exit") {
    return {
      type: "exit",
      message: colors.dim("Goodbye!"),
    };
  }

  if (command === "/doctor") {
    return {
      type: "doctor",
      message: await buildDoctorReport(messages),
    };
  }

  return {
    type: "unknown",
    message: colors.error(`Unknown command: ${command}`),
  };
}

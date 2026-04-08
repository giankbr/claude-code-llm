import type { GenericMessage, GenericTool, Provider } from "./providers/base";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAICompatProvider } from "./providers/openai-compat";
import { getGenericTools, initializeTools } from "./tools/registry";

let provider: Provider;

function getProvider(): Provider {
  if (!provider) {
    const providerName = process.env.PROVIDER || "anthropic";

    if (providerName === "ollama" || providerName === "openai-compat") {
      provider = new OpenAICompatProvider();
    } else {
      provider = new AnthropicProvider();
    }
  }

  return provider;
}

export async function* streamResponse(
  messages: GenericMessage[],
  tools?: GenericTool[],
  options?: {
    signal?: AbortSignal;
    sessionId?: string;
    correlationId?: string;
    permissionMode?: "default" | "auto" | "plan" | "bypassPermissions";
  }
): AsyncGenerator<string> {
  await initializeTools();
  const resolvedTools = tools ?? getGenericTools();
  const selectedProvider = getProvider();
  yield* selectedProvider.streamResponse(messages, resolvedTools, options);
}

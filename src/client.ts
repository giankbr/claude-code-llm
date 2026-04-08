import type { GenericMessage, GenericTool, Provider } from "./providers/base";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAICompatProvider } from "./providers/openai-compat";
import { TOOLS } from "./tools/registry";

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
  tools: GenericTool[] = TOOLS
): AsyncGenerator<string> {
  const selectedProvider = getProvider();
  yield* selectedProvider.streamResponse(messages, tools);
}

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat";
import { Provider, GenericMessage, GenericTool } from "./base";
import { executeTool } from "../tools";
import { getSystemPrompt } from "../prompts";

export class OpenAICompatProvider implements Provider {
  private client: OpenAI;
  private model: string;

  constructor() {
    const provider = process.env.PROVIDER || "anthropic";

    if (provider === "ollama") {
      const baseURL =
        process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
      this.model = process.env.OLLAMA_MODEL || "llama3.2";
      this.client = new OpenAI({
        apiKey: "ollama", // dummy key, Ollama doesn't check it
        baseURL,
      });
    } else {
      // openai-compat mode
      const baseURL = process.env.OPENAI_BASE_URL;
      const apiKey = process.env.OPENAI_API_KEY;
      this.model = process.env.OPENAI_MODEL;

      if (!baseURL || !apiKey || !this.model) {
        throw new Error(
          "For openai-compat provider, set OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL"
        );
      }

      this.client = new OpenAI({
        apiKey,
        baseURL,
      });
    }
  }

  async *streamResponse(
    messages: GenericMessage[],
    tools: GenericTool[] = []
  ): AsyncGenerator<string> {
    yield* this._streamResponseInternal(messages, tools);
  }

  private async *_streamResponseInternal(
    messages: GenericMessage[],
    tools: GenericTool[]
  ): AsyncGenerator<string> {
    // Convert generic messages to OpenAI format
    const openaiMessages: ChatCompletionMessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Convert generic tools to OpenAI format
    const openaiTools = tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object" as const,
          properties: tool.input_schema.properties,
          required: tool.input_schema.required,
        },
      },
    }));

    let fullResponse = "";
    let toolCalls: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages,
      stream: true,
      max_tokens: 2048,
      system: getSystemPrompt(),
      ...(openaiTools.length > 0 && { tools: openaiTools }),
    } as any);

    for await (const chunk of stream) {
      if (!chunk.choices[0]) continue;

      const delta = chunk.choices[0].delta;

      if (delta.content) {
        fullResponse += delta.content;
        yield delta.content;
      }

      if (delta.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          // Find or create tool call entry
          let toolCallEntry = toolCalls.find((tc) => tc.id === toolCall.id);
          if (!toolCallEntry) {
            toolCallEntry = {
              id: toolCall.id || "",
              name: toolCall.function?.name || "",
              input: {},
            };
            toolCalls.push(toolCallEntry);
          }

          if (toolCall.function?.name) {
            toolCallEntry.name = toolCall.function.name;
          }

          if (toolCall.function?.arguments) {
            try {
              const parsed = JSON.parse(toolCall.function.arguments);
              toolCallEntry.input = { ...toolCallEntry.input, ...parsed };
            } catch {
              // Partial JSON, accumulate in input
            }
          }
        }
      }
    }

    // Process tool calls if any
    if (toolCalls.length > 0) {
      // Append assistant message to generic messages
      messages.push({
        role: "assistant",
        content: fullResponse,
      });

      // Process each tool call
      for (const toolCall of toolCalls) {
        yield `[TOOL:${toolCall.name}:${JSON.stringify(toolCall.input)}]`;

        const result = await executeTool(toolCall.name, toolCall.input);
        yield `[RESULT:${result}]`;

        // Append tool result to messages
        messages.push({
          role: "user",
          content: `Tool ${toolCall.name} returned: ${result}`,
        });
      }

      // Recursively stream the continuation
      yield* this._streamResponseInternal(messages, tools);
    } else {
      // Update messages with the final response
      messages.push({
        role: "assistant",
        content: fullResponse,
      });
    }
  }
}

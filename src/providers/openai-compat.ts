import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat";
import type { Provider, GenericMessage, GenericTool } from "./base";
import { executeTool } from "../tools/registry";
import { getSystemPromptForTask } from "../prompts";
import { normalizeToolCallAlias } from "../tools/alias-map";
const MAX_TOOL_DEPTH = 10;

function parseToolArguments(rawArguments: string): Record<string, unknown> {
  const raw = rawArguments.trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    // Some local models add trailing text after the JSON body.
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = raw.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return {};
      }
    }
    return {};
  }
}

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
        apiKey: "ollama",
        baseURL,
      });
    } else {
      const baseURL = process.env.OPENAI_BASE_URL;
      const apiKey = process.env.OPENAI_API_KEY;
      const model = process.env.OPENAI_MODEL;

      if (!baseURL || !apiKey || !model) {
        throw new Error(
          "For openai-compat provider, set OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL"
        );
      }
      this.model = model;

      this.client = new OpenAI({
        apiKey,
        baseURL,
      });
    }
  }

  async *streamResponse(
    messages: GenericMessage[],
    tools: GenericTool[] = [],
    options?: {
      signal?: AbortSignal;
      sessionId?: string;
      correlationId?: string;
      permissionMode?: "default" | "auto" | "plan" | "bypassPermissions";
    }
  ): AsyncGenerator<string> {
    yield* this._streamResponseInternal(messages, tools, options);
  }

  private async *_streamResponseInternal(
    messages: GenericMessage[],
    tools: GenericTool[],
    options?: {
      signal?: AbortSignal;
      sessionId?: string;
      correlationId?: string;
      permissionMode?: "default" | "auto" | "plan" | "bypassPermissions";
    }
  ): AsyncGenerator<string> {
    const lastUserPrompt = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    const isGemma = /gemma/i.test(this.model);
    const maxTokens = isGemma ? 1536 : 2048;
    const openaiMessages: any[] = [
      { role: "system", content: getSystemPromptForTask(lastUserPrompt) },
      ...messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];

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

    let depth = 0;
    while (true) {
      if (depth > MAX_TOOL_DEPTH) {
        yield "\nTool loop depth limit reached.\n";
        break;
      }
      if (options?.signal?.aborted) {
        throw new Error("Cancelled by user");
      }
      let fullResponse = "";
      let toolCalls: Array<{
        id: string;
        name: string;
        rawArguments: string;
        input: Record<string, unknown>;
      }> = [];

      const stream = (await this.client.chat.completions.create({
        model: this.model,
        messages: openaiMessages as ChatCompletionMessageParam[],
        stream: true,
        max_tokens: maxTokens,
        tool_choice: "auto",
        ...(openaiTools.length > 0 && { tools: openaiTools }),
      } as any)) as unknown as AsyncIterable<any>;

      for await (const chunk of stream) {
        if (options?.signal?.aborted) {
          throw new Error("Cancelled by user");
        }
        if (!chunk.choices[0]) continue;

        const delta = chunk.choices[0].delta;

        if (delta.content) {
          fullResponse += delta.content;
          yield delta.content;
        }

        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const toolCallId =
              toolCall.id || `tool_${toolCall.index ?? 0}_${toolCalls.length}`;
            let toolCallEntry = toolCalls.find((tc) => tc.id === toolCallId);
            if (!toolCallEntry) {
              toolCallEntry = {
                id: toolCallId,
                name: toolCall.function?.name || "",
                rawArguments: "",
                input: {},
              };
              toolCalls.push(toolCallEntry);
            }

            if (toolCall.function?.name) {
              toolCallEntry.name = toolCall.function.name;
            }
            if (toolCall.function?.arguments) {
              toolCallEntry.rawArguments += toolCall.function.arguments;
            }
          }
        }
      }

      for (const toolCall of toolCalls) {
        toolCall.input = parseToolArguments(toolCall.rawArguments);
      }

      if (toolCalls.length === 0) {
        messages.push({
          role: "assistant",
          content: fullResponse,
        });
        break;
      }

      openaiMessages.push({
        role: "assistant",
        content: fullResponse || "",
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.rawArguments || JSON.stringify(tc.input),
          },
        })),
      });

      for (const toolCall of toolCalls) {
        const normalized = normalizeToolCallAlias({
          name: toolCall.name,
          arguments: toolCall.input,
        });
        yield `[TOOL:${normalized.name}:${JSON.stringify(normalized.arguments)}]`;
        const result = await executeTool(normalized.name, normalized.arguments, {
          workspaceRoot: process.cwd(),
          permissionMode: options?.permissionMode ?? "default",
          sessionId: options?.sessionId,
          correlationId: options?.correlationId,
          signal: options?.signal,
        });
        yield `[RESULT:${result}]`;

        openaiMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }
      depth += 1;
    }
  }
}

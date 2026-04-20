import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";
import type { Provider, GenericMessage, GenericTool } from "./base";
import { executeTool, getToolsSnapshot } from "../tools/registry";
import { getSystemPromptForTask } from "../prompts";
import { normalizeToolCallAlias } from "../tools/alias-map";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const MAX_TOOL_DEPTH = 10;

export class AnthropicProvider implements Provider {
  async *streamResponse(
    messages: GenericMessage[],
    tools?: GenericTool[],
    options?: {
      signal?: AbortSignal;
      sessionId?: string;
      correlationId?: string;
      permissionMode?: "default" | "auto" | "plan" | "bypassPermissions";
    }
  ): AsyncGenerator<string> {
    const resolvedTools = tools ?? (await getToolsSnapshot());
    // Convert generic messages to Anthropic format
    const anthropicMessages: MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Convert generic tools to Anthropic format
    const anthropicTools: Tool[] = resolvedTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as any,
    }));

    yield* this._streamResponseInternal(anthropicMessages, anthropicTools, messages, 0, options);
  }

  private async *_streamResponseInternal(
    anthropicMessages: MessageParam[],
    anthropicTools: Tool[],
    genericMessages: GenericMessage[],
    depth: number,
    options?: {
      signal?: AbortSignal;
      sessionId?: string;
      correlationId?: string;
      permissionMode?: "default" | "auto" | "plan" | "bypassPermissions";
    }
  ): AsyncGenerator<string> {
    if (depth > MAX_TOOL_DEPTH) {
      yield "\nTool loop depth limit reached.\n";
      return;
    }
    if (options?.signal?.aborted) {
      throw new Error("Cancelled by user");
    }
    let fullResponse = "";
    let toolCalls: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];

    const stream = await client.messages.stream({
      model: MODEL,
      max_tokens: 2048,
      system: getSystemPromptForTask(
        [...genericMessages].reverse().find((m) => m.role === "user")?.content || ""
      ),
      messages: anthropicMessages,
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
    });

    for await (const chunk of stream) {
      if (options?.signal?.aborted) {
        throw new Error("Cancelled by user");
      }
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta.type === "text_delta"
      ) {
        const text = chunk.delta.text;
        fullResponse += text;
        yield text;
      } else if (
        chunk.type === "content_block_start" &&
        chunk.content_block.type === "tool_use"
      ) {
        toolCalls.push({
          id: chunk.content_block.id,
          name: chunk.content_block.name,
          input: chunk.content_block.input as Record<string, unknown>,
        });
      }
    }

    const finalMessage = await stream.finalMessage();

    // Process tool calls if any
    if (finalMessage.stop_reason === "tool_use" && toolCalls.length > 0) {
      // Append assistant message to generic messages
      genericMessages.push({
        role: "assistant",
        content: fullResponse,
      });

      // Process each tool call
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

        genericMessages.push({ role: "user", content: `Tool ${normalized.name} returned: ${result}` });
      }

      const updatedAnthropicMessages: MessageParam[] = [...anthropicMessages];

      updatedAnthropicMessages.push({
        role: "assistant",
        content: toolCalls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: normalizeToolCallAlias({ name: call.name, arguments: {} }).name,
          input: call.input,
        })) as any,
      });
      updatedAnthropicMessages.push({
        role: "user",
        content: toolCalls.map((call, index) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: genericMessages[genericMessages.length - toolCalls.length + index]?.content || "",
        })) as any,
      });

      yield* this._streamResponseInternal(
        updatedAnthropicMessages,
        anthropicTools,
        genericMessages,
        depth + 1,
        options
      );
    } else {
      genericMessages.push({
        role: "assistant",
        content: fullResponse,
      });
    }
  }
}

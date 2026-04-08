import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";
import type { Provider, GenericMessage, GenericTool } from "./base";
import { executeTool, getGenericTools } from "../tools/registry";
import { getSystemPrompt } from "../prompts";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const MAX_TOOL_DEPTH = 10;

export class AnthropicProvider implements Provider {
  async *streamResponse(
    messages: GenericMessage[],
    tools: GenericTool[] = getGenericTools(),
    options?: {
      signal?: AbortSignal;
      sessionId?: string;
      permissionMode?: "default" | "auto" | "plan" | "bypassPermissions";
    }
  ): AsyncGenerator<string> {
    // Convert generic messages to Anthropic format
    const anthropicMessages: MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Convert generic tools to Anthropic format
    const anthropicTools: Tool[] = tools.map((t) => ({
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
      system: getSystemPrompt(),
      messages: anthropicMessages,
      tools: anthropicTools,
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
        yield `[TOOL:${toolCall.name}:${JSON.stringify(toolCall.input)}]`;

        const result = await executeTool(toolCall.name, toolCall.input, {
          workspaceRoot: process.cwd(),
          permissionMode: options?.permissionMode ?? "default",
          sessionId: options?.sessionId,
          signal: options?.signal,
        });
        yield `[RESULT:${result}]`;

        // Append tool result as a user message with both text and tool_result
        genericMessages.push({
          role: "user",
          content: `Tool ${toolCall.name} returned: ${result}`,
        });
      }

      // Update anthropic messages for recursion
      const updatedAnthropicMessages: MessageParam[] = [...anthropicMessages];

      // Add new messages from generic
      for (let i = anthropicMessages.length; i < genericMessages.length; i++) {
        const msg = genericMessages[i];
        if (!msg) {
          continue;
        }
        updatedAnthropicMessages.push({
          role: msg.role as any,
          content: msg.content,
        });
      }

      // Recursively stream the continuation
      yield* this._streamResponseInternal(
        updatedAnthropicMessages,
        anthropicTools,
        genericMessages,
        depth + 1,
        options
      );
    } else {
      // Update the generic messages array with the final response
      genericMessages.push({
        role: "assistant",
        content: fullResponse,
      });
    }
  }
}

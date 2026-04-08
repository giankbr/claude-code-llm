import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat";
import type { Provider, GenericMessage, GenericTool } from "./base";
import { executeTool } from "../tools/registry";
import { getSystemPromptForTask } from "../prompts";
import { normalizeToolCallAlias } from "../tools/alias-map";
import os from "os";
const MAX_TOOL_DEPTH = 10;
const MAX_SAME_TOOL_REPEAT = 3;
const MAX_INVALID_TOOL_INPUTS = 3;
const TOOL_COOLDOWN_THRESHOLD = 2;

function parseToolArguments(rawArguments: string): Record<string, unknown> {
  const raw = rawArguments.trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
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

function isValidToolName(name: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(name.trim());
}

/**
 * Normalise a file path coming from the model:
 *  - "Users/foo/bar/index.html"  →  absolute path missing leading "/"  →  prepend it
 *  - "/Users/.../workspace/index.html"  →  absolute inside workspace  →  strip prefix → "index.html"
 */
function normalizeFilePath(inputPath: string): string {
  const cwd = process.cwd();
  let p = inputPath.trim();

  // Add missing leading "/" for OS-root-looking relative paths
  if (!p.startsWith("/") && /^(Users|home|var|opt|tmp|root)\//.test(p)) {
    p = `/${p}`;
  }

  // Strip workspace root prefix → keep it relative
  if (p.startsWith(`${cwd}/`)) {
    p = p.slice(cwd.length + 1);
  } else if (p === cwd) {
    p = ".";
  }

  return p;
}

function getUserOnlyText(prompt: string): string {
  const requestMatch = prompt.match(/User request:\s*([\s\S]*)$/i);
  if (requestMatch && requestMatch[1]) {
    return requestMatch[1].trim();
  }
  const messageMatch = prompt.match(/User message:\s*([\s\S]*)$/i);
  if (messageMatch && messageMatch[1]) {
    return messageMatch[1].trim();
  }
  return prompt;
}

function selectHintSource(messages: GenericMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") {
      continue;
    }
    if (/^System (quality gate|feedback|guard):/i.test(msg.content)) {
      continue;
    }
    return msg.content;
  }
  return "";
}

function normalizeHintPath(raw: string): string {
  if (raw.startsWith("~/")) {
    return `${os.homedir()}/${raw.slice(2)}`;
  }
  return raw;
}

function extractListDirPathHint(prompt: string): string | null {
  const source = getUserOnlyText(prompt);
  const tildePathMatch = source.match(/(~\/[^\s,]+)/);
  if (tildePathMatch && tildePathMatch[1]) {
    return normalizeHintPath(tildePathMatch[1].replace(/[.,]$/, ""));
  }
  const absolutePathMatch = source.match(/(\/[^\s,]+)/);
  if (absolutePathMatch && absolutePathMatch[1]) {
    return absolutePathMatch[1].replace(/[.,]$/, "");
  }
  const folderMatch = source.match(/\bfolder\s+([a-zA-Z0-9._/-]+)/i);
  if (folderMatch && folderMatch[1]) {
    return folderMatch[1];
  }
  const apiMatch = source.match(/\bapi\/?\b/i);
  if (apiMatch) {
    return "api";
  }
  return null;
}

function getRequiredFields(
  toolName: string,
  tools: GenericTool[]
): string[] {
  const tool = tools.find((t) => t.name === toolName);
  return tool?.input_schema.required ?? [];
}

const FILE_EXT_RE =
  /\b([A-Za-z0-9._/-]+\.(?:html|css|js|ts|mjs|cjs|json|md|txt|jsx|tsx|py|sh|yaml|yml|env|toml|sql|rs|go|java|kt|swift|rb|php|c|cpp|h))\b/i;

interface ExtractedToolArgs {
  path?: string;
  content?: string;
  command?: string;
}

function extractArgsFromText(
  toolName: string,
  assistantText: string
): ExtractedToolArgs {
  const result: ExtractedToolArgs = {};

  if (toolName === "write_file" || toolName === "edit_file") {
    const fileMatch = assistantText.match(
      /(?:create|write|buat|file[:\s]+|path[:\s]+|→\s*)([A-Za-z0-9._/\\-]+\.[A-Za-z]{1,6})\b/i
    );
    if (!fileMatch) {
      const bareFile = assistantText.match(
        /\b([A-Za-z0-9_-]+\.(?:html|css|js|ts|json|md|txt|jsx|tsx|py|sh))\b/i
      );
      if (bareFile) result.path = bareFile[1];
    } else {
      result.path = fileMatch[1];
    }
    const codeBlock = assistantText.match(/```[a-z]*\n?([\s\S]+?)```/i);
    if (codeBlock && codeBlock[1]) {
      result.content = codeBlock[1].trim();
    }
  }

  if (toolName === "read_file" || toolName === "list_dir") {
    const fileMatch = assistantText.match(
      /\b([A-Za-z0-9._/\\-]+\.(?:html|css|js|ts|json|md|txt|jsx|tsx|py|sh|yaml|yml|env))\b/i
    );
    if (fileMatch) result.path = fileMatch[1];
  }

  if (toolName === "bash") {
    const shellBlock = assistantText.match(
      /```(?:bash|sh|shell|zsh)?\n?([\s\S]+?)```/i
    );
    if (shellBlock && shellBlock[1]) {
      result.command = shellBlock[1].trim().split("\n")[0]?.trim();
    }
    if (!result.command) {
      const inlineCmd = assistantText.match(/`([^`\n]{3,120})`/);
      if (inlineCmd && inlineCmd[1]) {
        result.command = inlineCmd[1].trim();
      }
    }
  }

  return result;
}

function repairToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  required: string[],
  assistantText: string
): { repaired: Record<string, unknown>; wasRepaired: boolean } {
  const missing = required.filter(
    (f) => !(f in args) || args[f] === undefined || args[f] === null || args[f] === ""
  );
  if (missing.length === 0) {
    return { repaired: args, wasRepaired: false };
  }
  const extracted = extractArgsFromText(toolName, assistantText);
  const repaired = { ...args };
  let anyFilled = false;
  for (const field of missing) {
    const val = (extracted as Record<string, unknown>)[field];
    if (val !== undefined && String(val).trim()) {
      repaired[field] = val;
      anyFilled = true;
    }
  }
  return { repaired, wasRepaired: anyFilled };
}

async function repairArgsWithModelCall(
  client: OpenAI,
  model: string,
  toolName: string,
  args: Record<string, unknown>,
  required: string[],
  userRequest: string,
  lastWrittenPath?: string,
  lastMentionedFilePath?: string
): Promise<{ repaired: Record<string, unknown>; wasRepaired: boolean }> {
  let missing = required.filter(
    (f) => !(f in args) || args[f] === undefined || args[f] === null || args[f] === ""
  );
  if (missing.length === 0) return { repaired: args, wasRepaired: false };

  // Universal path resolution for any file tool — runs FIRST
  const FILE_TOOLS = ["read_file", "write_file", "edit_file", "list_dir"];
  if (missing.includes("path") && FILE_TOOLS.includes(toolName)) {
    const pathHint =
      lastWrittenPath ||
      userRequest.match(FILE_EXT_RE)?.[1] ||
      lastMentionedFilePath;
    if (pathHint) {
      args = { ...args, path: normalizeFilePath(pathHint) };
      missing = missing.filter((f) => f !== "path");
      if (missing.length === 0) return { repaired: args, wasRepaired: true };
    }
  }

  let repairPrompt = "";

  if (toolName === "edit_file") {
    const needFind = missing.includes("find");
    const needReplace = missing.includes("replace");
    const filePath = args.path as string | undefined;
    if ((needFind || needReplace) && filePath) {
      let currentContent = "";
      try {
        const resolvedPath = filePath.startsWith("/")
          ? filePath
          : `${process.cwd()}/${filePath}`;
        currentContent = await Bun.file(resolvedPath).text();
      } catch {
        currentContent = "";
      }
      if (!currentContent) return { repaired: args, wasRepaired: false };

      const editPrompt =
        `User wants to: "${userRequest}"\n\n` +
        `Current file (${filePath}):\n${currentContent}\n\n` +
        `Provide ONLY the complete updated file content with all changes applied. No explanation, no markdown fences:`;
      try {
        const editResponse = await (client.chat.completions.create as Function)({
          model,
          messages: [{ role: "user", content: editPrompt }],
          max_tokens: 4096,
          stream: false,
        });
        const newContent: string =
          editResponse?.choices?.[0]?.message?.content?.trim() ?? "";
        if (!newContent) return { repaired: args, wasRepaired: false };
        const cleaned = newContent
          .replace(/^```[a-z]*\n?/i, "")
          .replace(/```\s*$/i, "")
          .trim();
        return {
          repaired: { ...args, find: currentContent, replace: cleaned },
          wasRepaired: true,
        };
      } catch {
        return { repaired: args, wasRepaired: false };
      }
    }
  }

  // read_file / list_dir — path already resolved above; if still missing, ask model
  if ((toolName === "read_file" || toolName === "list_dir") && missing.includes("path")) {
    repairPrompt =
      `The user requested: "${userRequest}"\n\n` +
      `Which file path should be read? Reply with ONLY the file path (e.g. index.html or src/app.ts):`;
  }

  if (toolName === "write_file" || toolName === "edit_file") {
    const needPath = missing.includes("path");
    const needContent = missing.includes("content");
    if (needPath && needContent) {
      repairPrompt =
        `The user requested: "${userRequest}"\n\n` +
        `You must create a file. Reply ONLY in this exact format, nothing else:\n` +
        `PATH: <filename>\nCONTENT:\n<complete file content>`;
    } else if (needContent) {
      repairPrompt =
        `The user requested: "${userRequest}"\n` +
        `File path: ${args.path}\n\n` +
        `Provide ONLY the complete file content with no explanation:`;
    } else if (needPath) {
      repairPrompt =
        `The user requested: "${userRequest}"\n\n` +
        `What filename should be used? Reply with ONLY the filename (e.g. index.html):`;
    }
  } else if (toolName === "bash") {
    repairPrompt =
      `The user requested: "${userRequest}"\n\n` +
      `Provide ONLY the single bash command to execute, no explanation:`;
  }

  if (!repairPrompt) return { repaired: args, wasRepaired: false };

  try {
    const response = await (client.chat.completions.create as Function)({
      model,
      messages: [{ role: "user", content: repairPrompt }],
      max_tokens: 2048,
      stream: false,
    });

    const text: string = response?.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) return { repaired: args, wasRepaired: false };

    const repaired = { ...args };
    let wasRepaired = false;

    if (toolName === "write_file" || toolName === "edit_file") {
      if (missing.includes("path") && missing.includes("content")) {
        const pathMatch = text.match(/^PATH:\s*(.+)$/im);
        const contentMatch = text.match(/^CONTENT:\s*\n([\s\S]+)$/im);
        if (pathMatch?.[1]) {
          repaired.path = pathMatch[1].trim();
          wasRepaired = true;
        }
        if (contentMatch?.[1]) {
          repaired.content = contentMatch[1].trim();
          wasRepaired = true;
        }
      } else if (missing.includes("content")) {
        repaired.content = text;
        wasRepaired = true;
      } else if (missing.includes("path")) {
        repaired.path = text.split("\n")[0]?.trim() ?? text;
        wasRepaired = true;
      }
    } else if (toolName === "read_file" || toolName === "list_dir") {
      const filePath = text.split("\n")[0]?.trim() ?? text;
      if (filePath) {
        repaired.path = filePath;
        wasRepaired = true;
      }
    } else if (toolName === "bash") {
      const cmd = text.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/i, "").trim();
      if (cmd) {
        repaired.command = cmd.split("\n")[0]?.trim() ?? cmd;
        wasRepaired = true;
      }
    }

    return { repaired, wasRepaired };
  } catch {
    return { repaired: args, wasRepaired: false };
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
    const hintSource = selectHintSource(messages);
    const lastUserPrompt = hintSource || [...messages].reverse().find((m) => m.role === "user")?.content || "";
    const listDirPathHint = extractListDirPathHint(lastUserPrompt);
    let lastMentionedFilePath: string | undefined;
    for (const msg of messages) {
      if (msg.role === "user") {
        const m = msg.content.match(FILE_EXT_RE);
        if (m?.[1]) lastMentionedFilePath = normalizeFilePath(m[1]);
      }
    }
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
    let previousToolFingerprint = "";
    let repeatedSameToolCount = 0;
    let invalidToolInputCount = 0;
    const invalidByTool = new Map<string, number>();
    const cooledDownTools = new Set<string>();
    let lastWrittenPath: string | undefined;
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

      const validToolCalls = toolCalls
        .map((toolCall) => ({
          ...toolCall,
          name: toolCall.name.trim(),
        }))
        .filter((toolCall) => isValidToolName(toolCall.name));

      if (validToolCalls.length === 0) {
        break;
      }

      openaiMessages.push({
        role: "assistant",
        content: fullResponse || "",
        tool_calls: validToolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.rawArguments || JSON.stringify(tc.input),
          },
        })),
      });

      for (const toolCall of validToolCalls) {
        const normalized = normalizeToolCallAlias({
          name: toolCall.name,
          arguments: toolCall.input,
        });
        if (cooledDownTools.has(normalized.name)) {
          const cooledResult = `Tool ${normalized.name} temporarily cooled down due to repeated invalid arguments in this turn. Provide complete arguments and retry in next turn.`;
          yield `[TOOL:${normalized.name}:${JSON.stringify(normalized.arguments)}]`;
          yield `[RESULT:${cooledResult}]`;
          openaiMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: cooledResult,
          });
          continue;
        }
        if (
          normalized.name === "list_dir" &&
          typeof normalized.arguments.path !== "string" &&
          listDirPathHint
        ) {
          normalized.arguments = { ...normalized.arguments, path: listDirPathHint };
        }

        // Stage 1: text-extraction repair (fast, no API call)
        const requiredFields = getRequiredFields(normalized.name, tools);
        const textRepair = repairToolArgs(
          normalized.name,
          normalized.arguments,
          requiredFields,
          fullResponse
        );
        let finalArgs = textRepair.wasRepaired ? textRepair.repaired : normalized.arguments;

        // Stage 2: targeted model call when fields are still missing
        const stillMissing = requiredFields.filter(
          (f) => !(f in finalArgs) || finalArgs[f] === undefined || finalArgs[f] === null || finalArgs[f] === ""
        );
        if (stillMissing.length > 0) {
          const modelRepair = await repairArgsWithModelCall(
            this.client,
            this.model,
            normalized.name,
            finalArgs,
            requiredFields,
            lastUserPrompt,
            lastWrittenPath,
            lastMentionedFilePath
          );
          if (modelRepair.wasRepaired) {
            finalArgs = modelRepair.repaired;
          }
        }
        if (
          typeof finalArgs.path === "string" &&
          ["read_file", "write_file", "edit_file", "list_dir"].includes(normalized.name)
        ) {
          finalArgs = { ...finalArgs, path: normalizeFilePath(finalArgs.path as string) };
        }
        normalized.arguments = finalArgs;

        const fingerprint = `${normalized.name}:${JSON.stringify(normalized.arguments)}`;
        if (fingerprint === previousToolFingerprint) {
          repeatedSameToolCount += 1;
        } else {
          repeatedSameToolCount = 1;
          previousToolFingerprint = fingerprint;
        }
        if (repeatedSameToolCount > MAX_SAME_TOOL_REPEAT) {
          yield "\nStopped repeated identical tool calls. Please provide explicit next action.\n";
          messages.push({
            role: "assistant",
            content:
              "Stopped repeated identical tool calls to avoid loop. Please refine the request with a specific target path or action.",
          });
          return;
        }

        yield `[TOOL:${normalized.name}:${JSON.stringify(normalized.arguments)}]`;
        const result = await executeTool(normalized.name, normalized.arguments, {
          workspaceRoot: process.cwd(),
          permissionMode: options?.permissionMode ?? "default",
          sessionId: options?.sessionId,
          correlationId: options?.correlationId,
          signal: options?.signal,
        });

        if (
          typeof normalized.arguments.path === "string" &&
          !result.toLowerCase().includes("failed") &&
          !result.toLowerCase().includes("error")
        ) {
          if (normalized.name === "write_file" || normalized.name === "edit_file") {
            lastWrittenPath = normalized.arguments.path as string;
          }
          if (["write_file", "edit_file", "read_file"].includes(normalized.name)) {
            lastMentionedFilePath = normalized.arguments.path as string;
          }
        }

        yield `[RESULT:${result}]`;

        if (/Invalid .* input: Missing required field:/i.test(result)) {
          invalidToolInputCount += 1;
          const currentInvalid = (invalidByTool.get(normalized.name) || 0) + 1;
          invalidByTool.set(normalized.name, currentInvalid);
          if (currentInvalid >= TOOL_COOLDOWN_THRESHOLD) {
            cooledDownTools.add(normalized.name);
          }
          const required = getRequiredFields(normalized.name, tools);
          if (required.length > 0) {
            openaiMessages.push({
              role: "user",
              content:
                `System feedback: Tool ${normalized.name} was called with incomplete arguments. ` +
                `Required fields: ${required.join(", ")}. ` +
                "Retry with a complete tool call and never use empty arguments {}.",
            });
          }
        } else {
          invalidToolInputCount = 0;
        }
        if (invalidToolInputCount >= MAX_INVALID_TOOL_INPUTS) {
          yield "\nStopped repeated invalid tool arguments. Provide complete tool arguments.\n";
          messages.push({
            role: "assistant",
            content:
              "Stopped repeated invalid tool arguments. Please provide complete arguments for each tool call (e.g. bash requires command).",
          });
          return;
        }

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

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat";
import type { Provider, GenericMessage, GenericTool } from "./base";
import { executeTool } from "../tools/registry";
import { getSystemPromptForTask } from "../prompts";
import { normalizeToolCallAlias } from "../tools/alias-map";
import os from "os";
const MAX_TOOL_DEPTH = 6;
const MAX_SAME_TOOL_REPEAT = 3;
const MAX_INVALID_TOOL_INPUTS = 3;
const TOOL_COOLDOWN_THRESHOLD = 2;

/**
 * Max wait for the first model output (text or tool call delta).
 * OPENAI_TIMEOUT_MS — after this, the request is aborted if nothing useful arrived yet.
 * Does NOT cap total streaming length (see OPENAI_HTTP_TIMEOUT_MS).
 */
function resolveOpenAIFirstTokenTimeoutMs(): number {
  const raw = process.env.OPENAI_TIMEOUT_MS;
  if (raw === undefined || raw === "") {
    return 90_000;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 3000) {
    return 90_000;
  }
  return Math.min(n, 600_000);
}

/** Max time for the full HTTP stream (long answers). Default 15 minutes. */
function resolveOpenAIHttpTimeoutMs(): number {
  const raw = process.env.OPENAI_HTTP_TIMEOUT_MS;
  if (raw === undefined || raw === "") {
    return 900_000;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 10_000) {
    return 900_000;
  }
  return Math.min(n, 3_600_000);
}

/**
 * Human-readable error when LM Studio / Ollama / OpenAI-compatible server is unreachable.
 * Exported for CLI error formatting in index.ts.
 */
export function formatOpenAICompatConnectionError(
  error: unknown,
  baseURL?: string
): string {
  const e = error instanceof Error ? error : new Error(String(error));
  const msg = e.message.toLowerCase();
  const code = (error as NodeJS.ErrnoException)?.code;
  const urlLine = baseURL ? `\nOPENAI_BASE_URL: ${baseURL}` : "";
  const hints =
    "Cek: (1) LM Studio / server API jalan, (2) model sudah di-load, (3) URL di .env berakhir /v1 (mis. http://127.0.0.1:1234/v1).";

  if (e.name === "AbortError" || msg.includes("aborted") || msg.includes("user aborted")) {
    return `Request dibatalkan (Ctrl+C) atau timeout.${urlLine}\n${hints}`;
  }
  if (
    code === "ECONNREFUSED" ||
    msg.includes("econnrefused") ||
    msg.includes("connection refused")
  ) {
    return `Tidak bisa connect ke server LLM (connection refused).${urlLine}\n${hints}`;
  }
  if (
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("connect timeout")
  ) {
    return `Timeout saat menghubungi server LLM.${urlLine}\n${hints}`;
  }
  if (code === "ENOTFOUND" || msg.includes("getaddrinfo") || msg.includes("enotfound")) {
    return `Host tidak ditemukan (DNS / salah alamat).${urlLine}`;
  }
  if (msg.includes("fetch failed") || msg.includes("network error") || msg.includes("socket")) {
    return `Gagal jaringan ke server LLM.${urlLine}\n${hints}`;
  }
  if (msg.includes("401") || msg.includes("403")) {
    return `API menolak autentikasi (401/403). Cek OPENAI_API_KEY di .env.${urlLine}`;
  }
  return `Request gagal: ${e.message}${urlLine}`;
}

function formatFirstTokenTimeoutMessage(ms: number, baseURL: string): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  const urlLine = baseURL ? `OPENAI_BASE_URL: ${baseURL}\n` : "";
  return (
    `Tidak ada output dari model dalam ${sec} detik (batas OPENAI_TIMEOUT_MS / first token).\n` +
    `${urlLine}` +
    `Biasanya: LM Studio belum jalan, model belum di-load, atau GPU/CPU kelebihan beban.\n` +
    `Kalau inference memang lambat, naikkan OPENAI_TIMEOUT_MS. Untuk batas panjang jawaban streaming, pakai OPENAI_HTTP_TIMEOUT_MS (default 15 menit).`
  );
}

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
  lastMentionedFilePath?: string,
  conversationContext?: string,
  targetDirHint?: string
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

      const contextBlock = conversationContext
        ? `\nConversation context:\n${conversationContext}\n`
        : "";
      const editPrompt =
        `You are editing the file "${filePath}".${contextBlock}\n` +
        `The user's latest request: "${userRequest}"\n\n` +
        `Current file content:\n${currentContent}\n\n` +
        `INSTRUCTIONS:\n` +
        `1. Apply ALL the changes described in the conversation context above\n` +
        `2. Output the COMPLETE updated file — every single line from start to end\n` +
        `3. Keep all existing content that was not asked to be changed\n` +
        `4. The file MUST be valid and complete (e.g. HTML must have closing </html>)\n` +
        `5. NO explanations, NO markdown fences, NO comments about changes\n` +
        `6. Start output with the very first line of the file\n` +
        `7. If user said "yes" or "proceed", apply all changes that were discussed previously`;
      // Scale token limit based on file size to prevent truncation
      const estimatedTokens = Math.ceil(currentContent.length / 3);
      const repairMaxTokens = Math.max(8192, estimatedTokens + 2048);
      try {
        const editResponse = await (client.chat.completions.create as Function)({
          model,
          messages: [{ role: "user", content: editPrompt }],
          max_tokens: repairMaxTokens,
          stream: false,
        });
        const newContent: string =
          editResponse?.choices?.[0]?.message?.content?.trim() ?? "";
        if (!newContent) return { repaired: args, wasRepaired: false };
        let cleaned = newContent
          .replace(/^```[a-z]*\n?/i, "")
          .replace(/```\s*$/i, "")
          .trim();
        // Truncation guard: if original had closing </html> but repair doesn't, reject
        if (currentContent.includes("</html>") && !cleaned.includes("</html>")) {
          return { repaired: args, wasRepaired: false };
        }
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
      const dirHintLine = targetDirHint
        ? `Target directory hint: ${targetDirHint}\nUse a path INSIDE this directory.\n`
        : "";
      repairPrompt =
        `The user requested: "${userRequest}"\n\n` +
        dirHintLine +
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
        // Fallback 1: JSON payload { "path": "...", "content": "..." }
        if (!wasRepaired) {
          try {
            const parsed = JSON.parse(text) as { path?: unknown; content?: unknown };
            if (typeof parsed.path === "string" && typeof parsed.content === "string") {
              repaired.path = parsed.path.trim();
              repaired.content = parsed.content;
              wasRepaired = true;
            }
          } catch {
            // ignore
          }
        }
        // Fallback 2: fenced code only, derive path from directory hint
        if (!wasRepaired) {
          const codeOnly = text.match(/```[a-z]*\n?([\s\S]+?)```/i);
          if (codeOnly?.[1]) {
            repaired.content = codeOnly[1].trim();
            const hintedPath = targetDirHint
              ? `${targetDirHint.replace(/\/+$/, "")}/index.js`
              : "index.js";
            repaired.path = hintedPath;
            wasRepaired = true;
          }
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

    // Final normalization for repaired paths
    if (typeof repaired.path === "string" && repaired.path.trim()) {
      repaired.path = normalizeFilePath(repaired.path);
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

    const clientOpts = {
      timeout: resolveOpenAIHttpTimeoutMs(),
      maxRetries: 0,
    } as const;

    if (provider === "ollama") {
      const baseURL =
        process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
      this.model = process.env.OLLAMA_MODEL || "llama3.2";
      this.client = new OpenAI({
        apiKey: "ollama",
        baseURL,
        ...clientOpts,
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
        ...clientOpts,
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
    const maxTokens = isGemma ? 1536 : 4096;
    let autoReadContent = "";
    const isDetailedRequest =
      lastUserPrompt.length > 150 ||
      /\b(improve|update|change|redesign|refactor|add|tambah|ubah|ganti|buat)\b/i.test(lastUserPrompt);
    const mentionedFile = lastMentionedFilePath;
    if (isDetailedRequest && mentionedFile) {
      try {
        const resolvedPath = mentionedFile.startsWith("/")
          ? mentionedFile
          : `${process.cwd()}/${mentionedFile}`;
        autoReadContent = await Bun.file(resolvedPath).text();
      } catch {}
    }

    const systemPrompt = getSystemPromptForTask(lastUserPrompt);
    let systemWithContext = systemPrompt;

    if (autoReadContent && mentionedFile) {
      systemWithContext +=
        `\n\n[AUTO-LOADED FILE CONTEXT]\n` +
        `The user is working on "${mentionedFile}". Current file content:\n` +
        `${autoReadContent}\n` +
        `[END FILE CONTEXT]\n\n` +
        `IMPORTANT: The file content is loaded above. When the user asks to modify this file, ` +
        `call edit_file with path="${mentionedFile}", find=<exact text to replace>, replace=<new text>. ` +
        `Do NOT just describe changes — you MUST call the tool to apply them.`;
    }

    // Session state — declared before buildSystemMessage so the closure can access them
    const sessionCreatedFiles: string[] = [];
    const sessionReadFiles: string[] = [];

    const buildSystemMessage = () => {
      let sys = systemWithContext;
      if (sessionCreatedFiles.length > 0) {
        const stateBlock =
          `\n\n[SESSION STATE]\n` +
          `Files created/modified so far: ${sessionCreatedFiles.join(", ")}\n` +
          `Files read so far: ${sessionReadFiles.join(", ")}\n` +
          `When the user asks follow-up questions (e.g. "can you run it?", "bisa dirun?"), ` +
          `they are referring to these files — NOT random project files.\n` +
          `[END SESSION STATE]`;
        sys = sys.replace(/\n\n\[SESSION STATE\][\s\S]*?\[END SESSION STATE\]/, "") + stateBlock;
      }
      // Force JSON output for action requests
      const isActionRequest = /\b(ubah|buat|edit|write|create|update|modify|run|jalankan|install|delete|remove)\b/i.test(lastUserPrompt);
      if (isActionRequest) {
        sys += `\n\n[EXECUTION REQUIREMENT]\nUser is requesting an action. You MUST emit JSON tool calls. Start your response with the JSON blocks, then explain. No text-only responses.`;
      }
      return sys;
    };
    const openaiMessages: any[] = [
      { role: "system", content: buildSystemMessage() },
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
    const toolNameCallCount = new Map<string, number>();
    const TOOL_NAME_MAX_REPEAT = 4;
    while (true) {
      if (depth > MAX_TOOL_DEPTH) {
        yield "\nTool loop depth limit reached.\n";
        break;
      }
      if (options?.signal?.aborted) {
        throw new Error("Cancelled by user");
      }
      // Refresh system message with latest session state
      openaiMessages[0] = { role: "system", content: buildSystemMessage() };

      let fullResponse = "";
      let toolCalls: Array<{
        id: string;
        name: string;
        rawArguments: string;
        input: Record<string, unknown>;
      }> = [];

      const baseURLForErrors =
        process.env.OPENAI_BASE_URL || process.env.OLLAMA_BASE_URL || "";

      const firstTokenMs = resolveOpenAIFirstTokenTimeoutMs();
      const requestAc = new AbortController();
      let ttfTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        requestAc.abort();
      }, firstTokenMs);
      let gotFirstProgress = false;

      const onParentAbort = () => {
        if (ttfTimer) {
          clearTimeout(ttfTimer);
          ttfTimer = undefined;
        }
        requestAc.abort();
      };
      if (options?.signal) {
        if (options.signal.aborted) {
          onParentAbort();
        } else {
          options.signal.addEventListener("abort", onParentAbort, { once: true });
        }
      }

      let stream: AsyncIterable<any>;
      try {
        stream = (await this.client.chat.completions.create({
          model: this.model,
          messages: openaiMessages as ChatCompletionMessageParam[],
          stream: true,
          max_tokens: maxTokens,
          ...(openaiTools.length > 0
            ? { tools: openaiTools, tool_choice: "auto" as const }
            : {}),
          signal: requestAc.signal,
        } as any)) as unknown as AsyncIterable<any>;
      } catch (err) {
        if (ttfTimer) {
          clearTimeout(ttfTimer);
          ttfTimer = undefined;
        }
        if (options?.signal?.aborted) {
          throw new Error("Cancelled by user");
        }
        if (!gotFirstProgress && requestAc.signal.aborted) {
          yield `\n${formatFirstTokenTimeoutMessage(firstTokenMs, baseURLForErrors)}\n`;
          return;
        }
        yield `\n${formatOpenAICompatConnectionError(err, baseURLForErrors)}\n`;
        return;
      }

      try {
        for await (const chunk of stream) {
          if (options?.signal?.aborted) {
            throw new Error("Cancelled by user");
          }
          if (!chunk.choices[0]) continue;

          const delta = chunk.choices[0].delta;

          const hasToolDelta =
            delta.tool_calls &&
            delta.tool_calls.some(
              (tc: { function?: { name?: string; arguments?: string } }) =>
                (tc.function?.name && tc.function.name.length > 0) ||
                (tc.function?.arguments && tc.function.arguments.length > 0)
            );

          if (!gotFirstProgress && (delta.content || hasToolDelta)) {
            gotFirstProgress = true;
            if (ttfTimer) {
              clearTimeout(ttfTimer);
              ttfTimer = undefined;
            }
          }

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
      } catch (err) {
        if (ttfTimer) {
          clearTimeout(ttfTimer);
          ttfTimer = undefined;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("Cancelled by user")) {
          throw err;
        }
        if (options?.signal?.aborted) {
          throw new Error("Cancelled by user");
        }
        if (!gotFirstProgress && requestAc.signal.aborted) {
          yield `\n${formatFirstTokenTimeoutMessage(firstTokenMs, baseURLForErrors)}\n`;
          return;
        }
        yield `\n${formatOpenAICompatConnectionError(err, baseURLForErrors)}\n`;
        return;
      } finally {
        if (ttfTimer) {
          clearTimeout(ttfTimer);
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
        if (tools.length === 0) {
          break;
        }
        const userWantsFileChange =
          !!lastMentionedFilePath &&
          messages.some(
            (m) =>
              m.role === "user" &&
              /\b(updat|chang|modif|improv|add|edit|creat|buat|ubah|ganti|tambah|perbaiki|redesign|refactor|fix|make|set|switch|all page|proceed|yes|ok|gas|lanjut)\b/i.test(
                m.content
              )
          );
        const userWantsScaffoldOrBuild = messages.some(
          (m) =>
            m.role === "user" &&
            /\b(generate|create|build|scaffold|setup|crud|api|express|nestjs|hono|fastify|project|boilerplate|init|buat)\b/i.test(
              m.content
            )
        );
        // Also catch when model describes UI changes (any verb form)
        const modelDescribesChanges =
          /\b(updat|chang|add|improv|enhanc|modif|replac|insert|creat|redesign|refactor|sudah|berhasil|ditambah|diubah|diperbaiki|I'll|I'm|Let me|Here's)\b/i.test(
            fullResponse
          ) &&
          /\b(file|section|page|styl|css|html|layout|footer|header|hero|card|button|font|color|gradient|animat|theme|design|component)\b/i.test(
            fullResponse
          );

        const shouldRetry =
          (userWantsFileChange || userWantsScaffoldOrBuild || modelDescribesChanges) &&
          depth < MAX_TOOL_DEPTH - 2;

        if (shouldRetry) {
          depth += 1;
          const changeDescription = fullResponse.slice(0, 600);
          openaiMessages.push(
            { role: "assistant", content: fullResponse },
            {
              role: "user",
              content:
                `System feedback: You responded with text but did NOT call any tool. ` +
                `The file has NOT been modified.\n\n` +
                `Your planned changes:\n"${changeDescription}"\n\n` +
                (lastMentionedFilePath
                  ? `Target file: ${lastMentionedFilePath}\n\n`
                  : "") +
                `You MUST call tools to actually modify files. Do this NOW:\n` +
                `1. If editing existing file: call read_file + edit_file.\n` +
                `2. If creating new project/files: call list_dir, then write_file with explicit path+content.\n` +
                `3. For dependency/setup commands, call bash with explicit command.\n` +
                `Example edit: edit_file({"path":"${lastMentionedFilePath || "index.html"}","find":"<old>","replace":"<new>"})\n` +
                `Example create: write_file({"path":"api/src/index.ts","content":"..."})\n` +
                `Do NOT respond with text. Call the tools immediately.`,
            }
          );
          continue;
        }
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
        if (
          normalized.name === "list_dir" &&
          typeof normalized.arguments.path !== "string" &&
          listDirPathHint
        ) {
          normalized.arguments = { ...normalized.arguments, path: listDirPathHint };
        }
        const requiredFields = getRequiredFields(normalized.name, tools);
        const textRepair = repairToolArgs(
          normalized.name,
          normalized.arguments,
          requiredFields,
          fullResponse
        );

        let finalArgs = textRepair.wasRepaired ? textRepair.repaired : normalized.arguments;
        const stillMissing = requiredFields.filter(
          (f) => !(f in finalArgs) || finalArgs[f] === undefined || finalArgs[f] === null || finalArgs[f] === ""
        );
        if (stillMissing.length > 0) {
          const userContext = messages
            .filter((m) => m.role === "user")
            .slice(-5)
            .map((m) => `- User: ${m.content.slice(0, 200)}`)
            .join("\n");
          const assistantIntent = fullResponse
            ? `\nAssistant's planned changes:\n${fullResponse.slice(0, 800)}`
            : "";
          const convContext = userContext + assistantIntent;
          const modelRepair = await repairArgsWithModelCall(
            this.client,
            this.model,
            normalized.name,
            finalArgs,
            requiredFields,
            lastUserPrompt,
            lastWrittenPath,
            lastMentionedFilePath,
            convContext,
            listDirPathHint ?? undefined
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

        // Only enforce cooldown if args are STILL incomplete after repair attempts.
        const missingAfterRepair = requiredFields.filter(
          (f) =>
            !(f in finalArgs) ||
            finalArgs[f] === undefined ||
            finalArgs[f] === null ||
            finalArgs[f] === ""
        );
        if (cooledDownTools.has(normalized.name) && missingAfterRepair.length > 0) {
          const cooledResult = `Tool ${normalized.name} temporarily cooled down due to repeated invalid arguments in this turn. Provide complete arguments and retry in next turn.`;
          yield `[TOOL:${normalized.name}:${JSON.stringify(finalArgs)}]`;
          yield `[RESULT:${cooledResult}]`;
          openaiMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: cooledResult,
          });
          continue;
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
        const nameCount = (toolNameCallCount.get(normalized.name) ?? 0) + 1;
        toolNameCallCount.set(normalized.name, nameCount);
        if (nameCount > TOOL_NAME_MAX_REPEAT) {
          const skipMsg = `Skipping ${normalized.name} — called ${nameCount} times this turn, likely looping.`;
          yield `[TOOL:${normalized.name}:${JSON.stringify(normalized.arguments)}]`;
          yield `[RESULT:${skipMsg}]`;
          openaiMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: skipMsg,
          });
          continue;
        }

        yield `[TOOL:${normalized.name}:${JSON.stringify(normalized.arguments)}]`;
        const result = await executeTool(normalized.name, normalized.arguments, {
          workspaceRoot: process.cwd(),
          permissionMode: options?.permissionMode ?? "default",
          sessionId: options?.sessionId,
          correlationId: options?.correlationId,
          signal: options?.signal,
        });

        const toolSucceeded =
          typeof normalized.arguments.path === "string" &&
          !result.toLowerCase().includes("failed") &&
          !result.toLowerCase().includes("error");

        if (toolSucceeded) {
          const filePath = normalized.arguments.path as string;
          if (normalized.name === "write_file" || normalized.name === "edit_file") {
            lastWrittenPath = filePath;
            if (!sessionCreatedFiles.includes(filePath)) {
              sessionCreatedFiles.push(filePath);
            }
          }
          if (["write_file", "edit_file", "read_file"].includes(normalized.name)) {
            lastMentionedFilePath = filePath;
          }
          if (normalized.name === "read_file" && !sessionReadFiles.includes(filePath)) {
            sessionReadFiles.push(filePath);
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

        // Nudge: after successful write_file, remind model what's done and what's next
        if (normalized.name === "write_file" && toolSucceeded && sessionCreatedFiles.length > 0) {
          const remaining = sessionCreatedFiles.length;
          openaiMessages.push({
            role: "user",
            content:
              `System: ✓ ${normalized.arguments.path} written successfully (${remaining} file(s) created so far: ${sessionCreatedFiles.join(", ")}). ` +
              `If there are more files to create, call write_file for the NEXT file now. ` +
              `Do NOT re-write files that already exist. Do NOT describe what to do — call the tool.`,
          });
        }
      }
      depth += 1;
    }
  }
}

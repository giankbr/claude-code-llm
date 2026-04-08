import { analytics } from "./analytics";

const EXCLUDED_SUGGESTION_TOOLS = new Set(["echo_tool"]);

const KEYWORD_TOOL_MAP: Array<{ regex: RegExp; tools: string[] }> = [
  { regex: /\b(read|show|lihat|baca)\b.*\b(file|berkas)\b/i, tools: ["read_file"] },
  { regex: /\b(write|buat|create|tulis)\b.*\b(file|berkas)\b/i, tools: ["write_file"] },
  { regex: /\b(edit|ubah|replace|update|change|ganti|tambah)\b/i, tools: ["read_file", "edit_file"] },
  { regex: /\b(list|ls|dir|folder)\b/i, tools: ["list_dir"] },
  { regex: /\b(search|find|cari|grep)\b/i, tools: ["search_files", "read_file"] },
  { regex: /\b(run|bash|command|jalankan|start|test|install|npm|bun|node)\b/i, tools: ["bash"] },
  { regex: /\b(generate|scaffold|crud|api|create|init|setup|boilerplate|buat)\b/i, tools: ["write_file", "bash"] },
  { regex: /\b(bisa|run|jalan|dirun|execute|coba)\b/i, tools: ["bash"] },
];

export function autoSuggest(input: string): string[] {
  const suggested = new Set<string>();

  for (const rule of KEYWORD_TOOL_MAP) {
    if (rule.regex.test(input)) {
      for (const tool of rule.tools) {
        if (!EXCLUDED_SUGGESTION_TOOLS.has(tool)) {
          suggested.add(tool);
        }
      }
    }
  }

  const summary = analytics.getSummary();
  const frequent = Object.entries(summary.byTool)
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 2)
    .map(([toolName]) => toolName);

  for (const toolName of frequent) {
    if (!EXCLUDED_SUGGESTION_TOOLS.has(toolName)) {
      suggested.add(toolName);
    }
  }

  return Array.from(suggested).slice(0, 3);
}


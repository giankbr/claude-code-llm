import pc from "picocolors";
import ora from "ora";
import { marked } from "marked";
import highlight from "cli-highlight";

export { pc };

export const colors = {
  user: (text: string) => pc.cyan(text),
  assistant: (text: string) => pc.green(text),
  tool: (text: string) => pc.yellow(text),
  dim: (text: string) => pc.dim(text),
  error: (text: string) => pc.red(text),
  label: (text: string) => pc.bold(pc.cyan(text)),
};

export const spinner = ora();

export function printHeader() {
  const title = "Sengiku AI CLI";
  const line = "─".repeat(title.length + 4);
  console.log(colors.dim(`╭${line}╮`));
  console.log(colors.dim(`│ ${title} │`));
  console.log(colors.dim(`╰${line}╯`));
  console.log();
}

export function printLabel(role: "Human" | "Assistant") {
  const label = role === "Human" ? colors.user("Human") : colors.assistant("Assistant");
  console.log(label);
}

export function printToolCall(name: string, input: Record<string, unknown>) {
  const inputStr = JSON.stringify(input, null, 2).split("\n").slice(0, 5).join("\n");
  const hasMore = JSON.stringify(input).length > 100;
  const content = hasMore ? inputStr + pc.dim("...") : inputStr;

  console.log(colors.dim(`╭─ Tool: ${name} ─`));
  console.log(colors.dim(content));
  console.log(colors.dim(`╰─ ─`));
}

export function printToolResult(result: string) {
  const preview = result.length > 200 ? result.substring(0, 200) + pc.dim("...") : result;
  console.log(colors.dim(`╭─ Result`));
  console.log(colors.dim(preview));
  console.log(colors.dim(`╰─ ─`));
  console.log();
}

function highlightCode(code: string, lang: string): string {
  try {
    // Try to highlight with language
    if (lang && lang.trim()) {
      return highlight(code, { language: lang, ignoreIllegals: true });
    }
    // Try to auto-detect
    return highlight(code, { ignoreIllegals: true });
  } catch {
    // If highlighting fails, return plain code with indent
    return code
      .split("\n")
      .map((line: string) => `  ${line}`)
      .join("\n");
  }
}

function renderCodeBlock(code: string, lang: string): string {
  const highlighted = highlightCode(code, lang);
  const border = colors.dim("─".repeat(Math.min(60, code.split("\n")[0]?.length || 20)));
  const langLabel = lang ? colors.dim(`[${lang}]`) : "";

  return `\n${border} ${langLabel}\n${highlighted}\n${border}\n`;
}

export function renderMarkdown(text: string): string {
  let output = "";
  let inCodeBlock = false;
  let codeContent = "";
  let codeLang = "";

  // Handle code blocks manually for better control
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] || "";

    // Detect code block start
    if (line.match(/^```(\w*)/)) {
      codeLang = line.substring(3).trim();
      codeContent = "";
      inCodeBlock = true;
      i++;
      continue;
    }

    // Detect code block end
    if (inCodeBlock && line === "```") {
      output += renderCodeBlock(codeContent.trim(), codeLang);
      inCodeBlock = false;
      i++;
      continue;
    }

    // Accumulate code content
    if (inCodeBlock) {
      codeContent += line + "\n";
      i++;
      continue;
    }

    // Format non-code lines
    let formatted = line;

    // Bold
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, (_, text: string) => pc.bold(text));

    // Inline code
    formatted = formatted.replace(/`([^`]+)`/g, (_, text: string) => pc.bgBlack(pc.cyan(` ${text} `)));

    // Headings
    if (formatted.match(/^#+\s/)) {
      const content = formatted.replace(/^#+\s/, "");
      formatted = pc.bold(pc.underline(content));
    }

    // Lists
    if (formatted.match(/^[-*]\s/)) {
      formatted = "  • " + formatted.replace(/^[-*]\s/, "");
    }

    output += formatted + "\n";
    i++;
  }

  return output;
}

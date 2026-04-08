import pc from "picocolors";
import ora from "ora";
import highlight from "cli-highlight";
import os from "os";

export { pc };

// Color palette matching Claude Code
export const colors = {
  user: (text: string) => pc.cyan(text),
  assistant: (text: string) => pc.green(text),
  tool: (text: string) => pc.yellow(text),
  dim: (text: string) => pc.dim(text),
  error: (text: string) => pc.red(text),
  label: (text: string) => pc.bold(pc.cyan(text)),
  badge: (text: string) => pc.dim(text),
  success: (text: string) => pc.green(text),
};

export const spinner = ora();

function getTerminalWidth(): number {
  return Math.max(process.stdout.columns || 80, 60);
}

function truncatePath(filePath: string, maxLen: number = 30): string {
  const home = os.homedir();
  let displayPath = filePath.replace(home, "~");
  if (displayPath.length > maxLen) {
    displayPath = "…" + displayPath.substring(displayPath.length - (maxLen - 1));
  }
  return displayPath;
}

export function printHeader(context?: { provider: string; model: string; cwd?: string }) {
  const width = getTerminalWidth();
  const innerWidth = width - 2;
  const title = "Sengiku Code";
  let contextStr = title;
  if (context) {
    contextStr += " · " + context.model;
    if (context.provider !== "anthropic") {
      contextStr += ` (${context.provider})`;
    }
    if (context.cwd) {
      contextStr += " · " + truncatePath(context.cwd);
    }
  }

  if (contextStr.length > innerWidth - 4) {
    contextStr = contextStr.substring(0, innerWidth - 7) + "…";
  }

  const topBorder = "╭" + "─".repeat(innerWidth) + "╮";
  const titlePad = Math.max(0, innerWidth - contextStr.length);
  const titleLine = "│" + contextStr + " ".repeat(titlePad) + "│";
  const hint = "Type /help for commands, /exit to quit";
  const hintPad = Math.max(0, innerWidth - hint.length);
  const hintLine = "│" + colors.dim(hint) + " ".repeat(hintPad) + "│";
  const bottomBorder = "╰" + "─".repeat(innerWidth) + "╯";

  console.log(colors.dim(topBorder));
  console.log(colors.dim(titleLine));
  console.log(colors.dim(hintLine));
  console.log(colors.dim(bottomBorder));
  console.log();
}

export function printLabel(role: "Human" | "Assistant", badge?: string) {
  const label = role === "Human" ? colors.user("You") : colors.assistant("Assistant");
  const badgeStr = badge ? colors.badge(" · " + badge) : "";
  console.log(label + badgeStr);
}

export function promptSymbol(): string {
  return colors.user("❯ ");
}

export function printToolCall(name: string, input: Record<string, unknown>) {
  const fullInput = JSON.stringify(input).replace(/"/g, "'");
  const tooltip = fullInput.length > 110 ? fullInput.substring(0, 107) + "…" : fullInput;
  console.log(colors.tool("⏺") + " " + colors.tool(name) + pc.dim(`(${tooltip})`));
  console.log(colors.dim("  └─ Running..."));
}

export function printToolResult(name: string, result: string, timeMs?: number) {
  const lines = result.split("\n");
  const maxLines = 8;
  const displayLines = lines.slice(0, maxLines);
  const hasMore = lines.length > maxLines;

  const timing = timeMs ? ` ${colors.dim(`(${timeMs}ms)`)}` : "";
  console.log(colors.success("✓") + " " + colors.success(name) + timing);

  for (const line of displayLines) {
    console.log(colors.dim("  │ ") + line);
  }

  if (hasMore) {
    console.log(colors.dim(`  │ ... ${lines.length - maxLines} more lines`));
  }

  console.log();
}

function highlightCode(code: string, lang: string): string {
  try {
    if (lang && lang.trim()) {
      return highlight(code, { language: lang, ignoreIllegals: true });
    }
    return highlight(code, { ignoreIllegals: true });
  } catch {
    return code;
  }
}

function renderCodeBlock(code: string, lang: string): string {
  const width = getTerminalWidth();
  const langLabel = lang ? ` ${lang} ` : " code ";
  const borderStart = "╭" + "─".repeat(2) + langLabel;
  const borderFill = Math.max(0, width - borderStart.length - 1);
  const topBorder = borderStart + "─".repeat(borderFill) + "╮";
  const bottomBorder = "╰" + "─".repeat(width - 2) + "╯";

  const highlighted = highlightCode(code.trim(), lang);
  const codeLines = highlighted.split("\n");

  let result = "\n" + colors.dim(topBorder) + "\n";

  for (const line of codeLines) {
    result += colors.dim("│ ") + line + "\n";
  }

  result += colors.dim(bottomBorder) + "\n";

  return result;
}

export function renderMarkdown(text: string): string {
  let output = "";
  const lines = text.split("\n");
  let i = 0;
  let inCodeBlock = false;
  let codeContent = "";
  let codeLang = "";

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

  return output.trimEnd();
}

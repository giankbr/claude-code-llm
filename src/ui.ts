import pc from "picocolors";
import ora from "ora";
import highlight from "cli-highlight";
import os from "os";
import inquirer from "inquirer";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
let cachedVersion: string | null = null;

function getTerminalWidth(): number {
  return Math.max(process.stdout.columns || 80, 60);
}

function padRight(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(0, maxLen - 1)) + "…";
}

function drawPanel(lines: string[], width: number): string[] {
  const innerWidth = Math.max(20, width - 2);
  const top = "╭" + "─".repeat(innerWidth) + "╮";
  const bottom = "╰" + "─".repeat(innerWidth) + "╯";
  const body = lines.map((line) => "│" + padRight(truncateText(line, innerWidth), innerWidth) + "│");
  return [top, ...body, bottom];
}

function padPanelLines(lines: string[], targetLength: number): string[] {
  const padded = [...lines];
  while (padded.length < targetLength) {
    padded.push("");
  }
  return padded;
}

function truncatePath(filePath: string, maxLen: number = 30): string {
  const home = os.homedir();
  let displayPath = filePath.replace(home, "~");
  if (displayPath.length > maxLen) {
    displayPath = "…" + displayPath.substring(displayPath.length - (maxLen - 1));
  }
  return displayPath;
}

function getAppVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    if (!existsSync(pkgPath)) {
      cachedVersion = "dev";
      return cachedVersion;
    }

    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      cachedVersion = parsed.version.trim();
      return cachedVersion;
    }
  } catch {
    // ignore parse/read errors and use fallback
  }

  cachedVersion = "dev";
  return cachedVersion;
}

export function printHeader(context?: { provider: string; model: string; cwd?: string }) {
  const width = getTerminalWidth();
  const contextStr = `Sengiku Code v${getAppVersion()}`;

  let providerInfo = "Anthropic";
  let modelInfo = "Claude";
  if (context) {
    modelInfo = context.model;
    if (context.provider !== "anthropic") {
      providerInfo = context.provider;
    }
  }

  const cwdPath = context?.cwd ? truncatePath(context.cwd, 44) : "~";
  const usableWidth = Math.min(width, 120);
  const panelWidth = Math.max(34, Math.floor((usableWidth - 3) / 2));
  const leftWidth = panelWidth;
  const rightWidth = panelWidth;
  const panelContentWidth = leftWidth + rightWidth + 3;

  const leftLines = [
    " Welcome back!",
    "",
    ` ${providerInfo} · ${modelInfo}`,
    ` ${cwdPath}`,
  ];

  const rightLines = [
    " Tips for getting started",
    " Run /init to create SENGIKU.md file with instructions.",
    "",
    " Recent activity",
    " No recent activity",
    "",
    " Commands: /help  /tools  /memory  /exit",
  ];

  const bodyRows = Math.max(leftLines.length, rightLines.length);
  const leftPanel = drawPanel(padPanelLines(leftLines, bodyRows), leftWidth);
  const rightPanel = drawPanel(padPanelLines(rightLines, bodyRows), rightWidth);
  const totalRows = leftPanel.length;

  for (let i = 0; i < totalRows; i++) {
    const left = leftPanel[i] || "";
    const right = rightPanel[i] || "";
    console.log(colors.dim(`${left}   ${right}`));
  }

  const divider = "─".repeat(Math.max(30, Math.min(width, panelContentWidth)));
  const contextLine = truncateText(contextStr, Math.max(20, width - 2));
  console.log(colors.dim(contextLine));

  console.log(colors.dim(divider));
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

export function printToolSectionHeader(): void {
  console.log(colors.dim("Tool Calls"));
}

export function printChatDivider(): void {
  const width = getTerminalWidth();
  const divider = "─".repeat(Math.max(30, width - 2));
  console.log(colors.dim(divider));
}

export function printToolCall(name: string, input: Record<string, unknown>) {
  const fullInput = JSON.stringify(input).replace(/"/g, "'");
  const tooltip = fullInput.length > 96 ? fullInput.substring(0, 93) + "…" : fullInput;
  console.log(colors.tool("• ") + colors.tool(name) + pc.dim(`(${tooltip})`));
  console.log(colors.dim("  ↳ running..."));
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

export async function confirmTool(
  name: string,
  input: Record<string, unknown>
): Promise<boolean> {
  const inputStr = JSON.stringify(input).substring(0, 80);
  const { confirmed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmed",
      message: `Allow tool "${name}"? (input: ${inputStr}${inputStr.length > 80 ? "..." : ""})`,
      default: false,
    },
  ]);
  return confirmed;
}

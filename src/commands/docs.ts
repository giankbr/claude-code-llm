import type { Command } from "./base";
import { initializeTools, getGenericTools, getTool } from "../tools/registry";
import { colors } from "../ui";

export const docsCommand: Command = {
  name: "docs",
  aliases: ["doc", "help-tool"],
  description: "Show tool documentation and usage",
  async handler(args, _messages) {
    await initializeTools();
    const toolName = args.trim();

    if (!toolName) {
      return await listAllTools();
    }

    const tool = getTool(toolName);
    if (!tool) {
      return {
        type: "docs",
        message: colors.error(`Tool not found: ${toolName}`),
      };
    }

    return generateToolDoc(tool);
  },
};

async function listAllTools() {
  const tools = getGenericTools();

  const docs = tools
    .map((t) => {
      const metadata = getTool(t.name);
      const tags = metadata?.tags?.join(", ") || "n/a";
      const readonly = metadata?.isReadOnly() ? "📖 " : "✏️  ";
      return `${readonly}${t.name.padEnd(18)} — ${t.description}\n   ${colors.dim(`tags: ${tags}`)}`;
    })
    .join("\n\n");

  const message = `
${colors.dim("Available Tools:")}
${docs}

${colors.dim("Run '/docs <tool-name>' for detailed documentation")}
    `.trim();

  return {
    type: "docs" as const,
    message,
  };
}

function generateToolDoc(tool: any) {
  const inputFields = Object.entries(tool.input_schema.properties || {})
    .map(([key, prop]: any) => {
      const required = tool.input_schema.required?.includes(key) ? "required" : "optional";
      return `  - ${colors.tool(key)} (${prop.type}) [${required}]\n    ${prop.description || ""}`;
    })
    .join("\n");

  const metadata = [
    `Read-only: ${tool.isReadOnly ? "yes" : "no"}`,
    `Destructive: ${tool.isDestructive ? "yes" : "no"}`,
    `Concurrency-safe: ${tool.isConcurrencySafe ? "yes" : "no"}`,
    tool.version ? `Version: ${tool.version}` : null,
    tool.maxResultSizeChars
      ? `Max result size: ${(tool.maxResultSizeChars / 1000).toFixed(0)}KB`
      : null,
    tool.tags?.length ? `Tags: ${tool.tags.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const message = `
${colors.dim(`Tool: ${tool.name}`)}

${colors.dim("Description:")}
  ${tool.description}

${colors.dim("Input Parameters:")}
${inputFields || "  (none)"}

${colors.dim("Properties:")}
  ${metadata}

${colors.dim("Example:")}
  > use ${tool.name} to [describe what you want]
    `.trim();

  return {
    type: "docs" as const,
    message,
  };
}

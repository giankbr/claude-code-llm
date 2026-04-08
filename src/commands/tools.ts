import type { Command } from "./base";
import { TOOLS } from "../tools/registry";
import { colors } from "../ui";

export const toolsCommand: Command = {
  name: "tools",
  description: "List available tools",
  async handler() {
    const lines = TOOLS.map((tool) => {
      return `  ${colors.tool(tool.name)} - ${tool.description}`;
    });

    return {
      type: "tools",
      message: `${colors.dim("Available tools:")} \n${lines.join("\n")}`,
    };
  },
};

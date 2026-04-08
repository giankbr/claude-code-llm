import type { Command } from "./base";
import { getGenericTools, initializeTools } from "../tools/registry";
import { colors } from "../ui";

export const toolsCommand: Command = {
  name: "tools",
  description: "List available tools",
  async handler() {
    await initializeTools();
    const tools = getGenericTools();
    const lines = tools.map((tool) => {
      return `  ${colors.tool(tool.name)} - ${tool.description}`;
    });

    return {
      type: "tools",
      message: `${colors.dim("Available tools:")} \n${lines.join("\n")}`,
    };
  },
};

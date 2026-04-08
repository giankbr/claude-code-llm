import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Tool } from "./base";

function isToolShape(value: unknown): value is Tool {
  if (!value || typeof value !== "object") {
    return false;
  }
  const tool = value as Partial<Tool>;
  return (
    typeof tool.name === "string" &&
    typeof tool.description === "string" &&
    typeof tool.execute === "function" &&
    typeof tool.checkPermissions === "function"
  );
}

export async function loadPluginTools(pluginDir: string): Promise<Tool[]> {
  if (!existsSync(pluginDir)) {
    return [];
  }

  const files = readdirSync(pluginDir).filter(
    (file) => file.endsWith(".ts") || file.endsWith(".js") || file.endsWith(".mjs")
  );

  const tools: Tool[] = [];
  for (const file of files) {
    const absolutePath = path.join(pluginDir, file);
    try {
      const module = await import(pathToFileURL(absolutePath).href);
      const maybeTool = module.default;
      if (isToolShape(maybeTool)) {
        tools.push(maybeTool);
      }
    } catch {
      // Ignore invalid plugin modules to keep startup resilient.
    }
  }

  return tools;
}


import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Tool } from "./base";
import { logger } from "../logger";

interface PluginManifest {
  name: string;
  version: string;
  description: string;
  permissions: string[];
  checksum: string;
}

function readManifest(pluginPath: string): PluginManifest | null {
  const manifestPath = `${pluginPath}.manifest.json`;
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest;
  } catch {
    return null;
  }
}

function verifyManifest(pluginPath: string, manifest: PluginManifest): boolean {
  if (!manifest.name || !manifest.version || !manifest.description) {
    return false;
  }
  const fileContent = readFileSync(pluginPath);
  const checksum = createHash("sha256").update(fileContent).digest("hex");
  return checksum === manifest.checksum;
}

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
    const manifestMode = (process.env.SENGIKU_PLUGIN_MANIFEST_MODE || "warn").toLowerCase();
    const manifest = readManifest(absolutePath);
    if (!manifest || !verifyManifest(absolutePath, manifest)) {
      const message = `Plugin skipped/flagged (${file}): manifest missing or invalid checksum`;
      if (manifestMode === "enforce") {
        logger.warn(message);
        continue;
      }
      logger.warn(`${message} (warn mode)`);
    }
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


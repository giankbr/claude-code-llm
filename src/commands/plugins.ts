import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { Command } from "./base";
import { colors } from "../ui";

const PLUGIN_DIR = path.join(process.cwd(), ".sengiku", "plugins");
const VALID_EXT = new Set([".ts", ".js", ".mjs"]);

function ensurePluginDir(): void {
  if (!existsSync(PLUGIN_DIR)) {
    mkdirSync(PLUGIN_DIR, { recursive: true });
  }
}

function isPluginFile(filePath: string): boolean {
  return VALID_EXT.has(path.extname(filePath).toLowerCase());
}

function listPlugins(): string[] {
  if (!existsSync(PLUGIN_DIR)) {
    return [];
  }
  return readdirSync(PLUGIN_DIR).filter((name) => isPluginFile(name));
}

export const pluginsCommand: Command = {
  name: "plugins",
  aliases: ["plugin", "skill", "skills"],
  description: "Manage local Sengiku plugins",
  async handler(args) {
    ensurePluginDir();
    const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const subcommand = sub || "list";

    if (subcommand === "list") {
      const plugins = listPlugins();
      return {
        type: "plugins",
        message:
          plugins.length === 0
            ? colors.dim("No plugins installed in .sengiku/plugins")
            : `${colors.dim("Installed plugins:")}\n${plugins.map((p) => `  - ${p}`).join("\n")}`,
      };
    }

    if (subcommand === "install") {
      const source = rest.join(" ").trim();
      if (!source) {
        return {
          type: "plugins",
          message: colors.error("Usage: /plugins install <path-to-plugin-file>"),
        };
      }
      const resolved = path.resolve(process.cwd(), source);
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        return {
          type: "plugins",
          message: colors.error(`Plugin file not found: ${source}`),
        };
      }
      if (!isPluginFile(resolved)) {
        return {
          type: "plugins",
          message: colors.error("Plugin file must end with .ts, .js, or .mjs"),
        };
      }
      const fileName = path.basename(resolved);
      const target = path.join(PLUGIN_DIR, fileName);
      copyFileSync(resolved, target);
      return {
        type: "plugins",
        message: `${colors.success("✓")} Installed plugin: ${fileName}\n${colors.dim(`Target: ${target}`)}\n${colors.dim("Restart session to reload plugins.")}`,
      };
    }

    if (subcommand === "remove" || subcommand === "uninstall") {
      const pluginName = rest.join(" ").trim();
      if (!pluginName) {
        return {
          type: "plugins",
          message: colors.error("Usage: /plugins remove <plugin-file-name>"),
        };
      }
      const target = path.join(PLUGIN_DIR, path.basename(pluginName));
      if (!existsSync(target)) {
        return {
          type: "plugins",
          message: colors.error(`Plugin not found: ${pluginName}`),
        };
      }
      rmSync(target);
      return {
        type: "plugins",
        message: `${colors.success("✓")} Removed plugin: ${path.basename(pluginName)}`,
      };
    }

    return {
      type: "plugins",
      message: colors.error(
        "Unknown plugins subcommand. Use: /plugins list | /plugins install <path> | /plugins remove <name>"
      ),
    };
  },
};


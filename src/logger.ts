import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function getConfiguredLevel(): LogLevel {
  const raw = (process.env.SENGIKU_LOG_LEVEL || "warn").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "warn";
}

const LOG_DIR = path.join(process.cwd(), ".sengiku");
const LOG_FILE = path.join(LOG_DIR, "debug.log");

function ensureLogDir(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

class Logger {
  private minLevel = getConfiguredLevel();

  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }
    const payload = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(data ? { data } : {}),
    };
    const line = JSON.stringify(payload);
    // Write to file instead of console to avoid polluting chat output
    ensureLogDir();
    try {
      appendFileSync(LOG_FILE, line + "\n");
    } catch {}
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", message, data);
  }
}

export const logger = new Logger();


export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function getConfiguredLevel(): LogLevel {
  const raw = (process.env.SENGIKU_LOG_LEVEL || "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
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
    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
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


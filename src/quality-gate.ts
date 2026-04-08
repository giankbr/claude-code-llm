export interface ExecutedToolEvent {
  toolName: string;
  input: Record<string, unknown>;
  result: string;
}

function hasCrudSignals(text: string): boolean {
  return /\b(get|post|put|delete|crud)\b/i.test(text);
}

function extractRequestedTargetDir(input: string): string | null {
  const absolutePathMatch = input.match(/(\/[^\s]+)/);
  if (absolutePathMatch && absolutePathMatch[1]) {
    return absolutePathMatch[1].replace(/[.,]$/, "");
  }

  const folderMatch = input.match(/folder baru(?: bernama)?\s+([A-Za-z0-9._-]+)/i);
  if (folderMatch && folderMatch[1]) {
    return folderMatch[1];
  }
  return null;
}

export function evaluateToolExecution(
  userInput: string,
  events: ExecutedToolEvent[]
): string | null {
  if (events.length === 0) {
    return null;
  }

  const wantsHono = /\bhono\b/i.test(userInput);
  const wantsCrud = hasCrudSignals(userInput);
  const allText = events
    .map((event) => `${event.toolName}\n${JSON.stringify(event.input)}\n${event.result}`)
    .join("\n");

  if (wantsHono && /\bexpress\b/i.test(allText)) {
    return [
      "Quality gate failed: user requested Hono but execution introduced Express.",
      "Fix by using Hono only and remove Express-specific files/commands.",
    ].join(" ");
  }

  if (wantsCrud) {
    const touchedFiles = events.filter(
      (event) => event.toolName === "write_file" || event.toolName === "edit_file"
    );
    if (touchedFiles.length === 0) {
      return "Quality gate failed: CRUD task requested but no file changes were made.";
    }
  }

  const requestedTargetDir = extractRequestedTargetDir(userInput);
  if (requestedTargetDir) {
    for (const event of events) {
      if (event.toolName !== "write_file" && event.toolName !== "edit_file") {
        continue;
      }
      const filePath = typeof event.input.path === "string" ? event.input.path : "";
      if (!filePath) {
        continue;
      }
      if (!filePath.includes(requestedTargetDir)) {
        return `Quality gate failed: file change (${filePath}) is outside requested target (${requestedTargetDir}).`;
      }
    }
  }

  const hasTypecheck = events.some((event) => {
    if (event.toolName !== "bash") {
      return false;
    }
    const command = typeof event.input.command === "string" ? event.input.command : "";
    return /\b(typecheck|tsc --noEmit)\b/i.test(command);
  });

  if (/build|setup|buat|create|api|crud|hono|typescript/i.test(userInput) && !hasTypecheck) {
    return "Quality gate warning: no typecheck step detected. Run typecheck before final response.";
  }

  return null;
}


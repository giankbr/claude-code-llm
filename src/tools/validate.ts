import type { Tool } from "./base";

function getValueType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function isTypeMatch(expected: unknown, value: unknown): boolean {
  if (typeof expected !== "string") {
    return true;
  }
  if (expected === "array") {
    return Array.isArray(value);
  }
  if (expected === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return typeof value === expected;
}

export function validateToolInput(
  tool: Tool,
  input: Record<string, unknown>
): { ok: true } | { ok: false; errors: string[] } {
  const required = tool.input_schema.required ?? [];
  const properties = tool.input_schema.properties ?? {};
  const errors: string[] = [];

  for (const key of required) {
    if (!(key in input)) {
      errors.push(`Missing required field: ${key}`);
    }
  }

  for (const [key, schema] of Object.entries(properties)) {
    if (!(key in input)) {
      continue;
    }
    const expectedType =
      schema && typeof schema === "object" && "type" in schema
        ? (schema as { type?: unknown }).type
        : undefined;
    const actual = input[key];
    if (!isTypeMatch(expectedType, actual)) {
      errors.push(
        `Invalid type for ${key}: expected ${String(expectedType)}, got ${getValueType(actual)}`
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}


export interface GenericMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenericTool {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface Provider {
  streamResponse(
    messages: GenericMessage[],
    tools?: GenericTool[],
    options?: {
      signal?: AbortSignal;
      sessionId?: string;
      correlationId?: string;
      permissionMode?: "default" | "auto" | "plan" | "bypassPermissions";
    }
  ): AsyncGenerator<string>;
}

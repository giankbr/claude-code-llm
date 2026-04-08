export interface TextToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

type AliasTransform = (args: Record<string, unknown>) => Record<string, unknown>;

interface AliasRule {
  canonicalName: string;
  transform?: AliasTransform;
}

const ALIAS_RULES: Record<string, AliasRule> = {
  git_log: { canonicalName: "git_tool", transform: (args) => ({ ...args, action: "log" }) },
  git_status: {
    canonicalName: "git_tool",
    transform: (args) => ({ ...args, action: "status" }),
  },
  git_diff: { canonicalName: "git_tool", transform: (args) => ({ ...args, action: "diff" }) },
  git_branch: {
    canonicalName: "git_tool",
    transform: (args) => ({ ...args, action: "branch" }),
  },
};

export function normalizeToolCallAlias(call: TextToolCall): TextToolCall {
  const name = call.name.trim().toLowerCase();
  const rule = ALIAS_RULES[name];
  if (!rule) {
    return call;
  }
  return {
    name: rule.canonicalName,
    arguments: rule.transform ? rule.transform(call.arguments) : call.arguments,
  };
}


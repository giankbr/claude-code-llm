# SENGIKU.md — Sengiku Code

Project instructions for AI coding assistants working on **Sengiku Code**: a Bun + TypeScript CLI that streams LLM replies, runs a tool loop (files, shell, search, sub-agent), and supports Anthropic, Ollama, and OpenAI-compatible servers.

---

## Product intent

- **User experience**: Fast REPL, clear tool output, safe defaults around permissions and workspace paths.
- **Engineering**: Provider-agnostic core (`GenericMessage`, `GenericTool`, `Provider`); behavior changes should stay localized (one provider, one tool, or one command at a time unless a cross-cutting design is agreed).

---

## Stack

| Item | Choice |
|------|--------|
| Runtime | [Bun](https://bun.sh) |
| Language | TypeScript (strict), ESM (`"type": "module"`) |
| Entry | `index.ts` at repo root |
| LLM SDKs | `@anthropic-ai/sdk`, `openai` (compat base URL) |
| CLI UX | `inquirer`, `marked`, `picocolors`, `ora` |

Do **not** assume Node-only APIs without checking Bun compatibility.

---

## Repo map

| Path | Role |
|------|------|
| `src/index.ts` | Main REPL: input loop, message history, tool marker parsing, quality gate hooks |
| `src/client.ts` | Loads tools, selects provider from `PROVIDER` env |
| `src/providers/base.ts` | `Provider`, `GenericMessage`, `GenericTool` |
| `src/providers/anthropic.ts` | Claude streaming + tool loop |
| `src/providers/openai-compat.ts` | OpenAI-shaped API (LM Studio, vLLM, Ollama `/v1`) + tool loop |
| `src/tools/*.ts` | Built-in tools (`read_file`, `write_file`, `bash`, `list_dir`, `search_files`, `edit_file`, `agent`) |
| `src/tools/registry.ts` | Registration, `executeTool`, `getGenericTools`, retries |
| `src/tools/loader.ts` | Optional plugins from `.sengiku/plugins/` |
| `src/commands/*.ts` | Slash commands; wired in `src/commands/registry.ts` |
| `src/prompts.ts` | System prompt assembly (`SYSTEM_PROMPT_TYPE`, modular code prompt) |
| `src/prompt-modules.ts` | Stable/dynamic prompt sections |
| `src/tool-prompts.ts` | Tool descriptions / prompt bundles |
| `src/ui.ts` | Terminal output, markdown, spinners |
| `src/permissions.ts`, `src/policy.ts` | Tool permission policy |
| `src/quality-gate.ts` | Post-tool validation nudges |
| `src/eval/` | Optional eval runner (`bun run eval`) |

Workspace metadata (not always committed): `.sengiku/rules.md`, `.sengiku/memory.json`, `.sengiku/plugins/`.

---

## Conventions

1. **Minimal diffs** — Fix the requested behavior; avoid drive-by refactors or unrelated formatting.
2. **Match existing style** — Imports, naming, error strings (including Indonesian user-facing copy where the file already uses it).
3. **Tools** — Implement `Tool` from `src/tools/base.ts`: `checkPermissions`, `execute`, accurate `input_schema` (`required` explicit). Register in `src/tools/registry.ts`. For model-facing hints, extend `src/tool-prompts.ts` when appropriate.
4. **Commands** — Implement `Command` from `src/commands/base.ts`, export from `src/commands/registry.ts`.
5. **Providers** — Keep streaming and tool-loop semantics aligned with the other provider where reasonable; document intentional differences in PR/commit text.
6. **Secrets** — Never commit API keys. `.env` is local; use `.env.example` if adding new vars (create/update if missing).

---

## Commands to run after code changes

```bash
bun install          # if dependencies changed
bun run typecheck  # tsc --noEmit
bun test           # e.g. src/tools/registry.test.ts, src/tool-prompts.test.ts
```

For manual smoke: `bun run index.ts` (requires configured `.env`).

---

## Configuration (local dev)

See `README.md` and `.env`. Typical variables:

- `PROVIDER`: `anthropic` | `ollama` | `openai-compat`
- Provider-specific model and base URL vars as documented in README.

---

## Things to watch

- **Context size**: Local models with small `n_ctx` may fail on full tool + system payload; `SYSTEM_PROMPT_TYPE=minimal` helps.
- **Casual vs action turns**: `src/index.ts` uses `isLikelyActionRequest` and `toolsForTurn` to skip tools for small talk; provider retry logic must not nag for tools when no tools were offered (`openai-compat.ts`).
- **Plugin manifests**: `.sengiku/plugins/*.manifest.json` checksum must match plugin source if manifest verification is enforced.

---

## Documentation

- **User-facing**: `README.md`, `QUICKSTART.md` (if present).
- **This file**: Assistant-oriented; keep it accurate when architecture shifts.

When you complete a non-trivial change, update **this file** or **README** if behavior or layout changed.

# Sengiku AI CLI

A lightweight Claude Code-inspired REPL with multi-provider support. Chat with AI, use tools, stay in control.

Supports:
- **Anthropic** (Claude 3.5 Sonnet, Haiku) — Powerful & accurate
- **Ollama** (LLaMA, Mistral, etc.) — Run models locally, completely private
- **OpenAI-compatible** (LM Studio, vLLM, LocalAI) — Use any compatible server

## Quick Start

### Default (Anthropic)
```bash
bun install
bun run index.ts
```

### Local Ollama
```bash
# Terminal 1: Run a model
ollama run llama3.2

# Terminal 2: Start the CLI
PROVIDER=ollama OLLAMA_MODEL=llama3.2 bun run index.ts
```

### LM Studio / vLLM
```bash
PROVIDER=openai-compat \
  OPENAI_BASE_URL=http://localhost:1234/v1 \
  OPENAI_API_KEY=lm-studio \
  OPENAI_MODEL=mistral-7b \
  bun run index.ts
```

See **QUICKSTART.md** for detailed setup.

## Features

- **Streaming responses** — Watch tokens appear in real-time
- **Tool use** — Read files, write files, run bash commands
- **Multi-turn conversation** — Full message history
- **Slash commands** — `/help`, `/clear`, `/exit`
- **Provider agnostic** — Switch providers with one env var

## Usage

```
> what's in this directory?
[Tool: bash] {"command":"ls -la"}
[Result]
total 120
drwxr-xr-x   13 user  staff   416 Apr  8 09:50 .

Looks like you have a Bun project here with...

> read package.json
[Tool: read_file] {"path":"package.json"}
[Result]
{"name":"agent-ai-llm",...}

This is the Sengiku AI CLI built with TypeScript and Bun...

> /clear
Conversation history cleared.
```

## Architecture

```
src/providers/        # Multi-provider support
├── base.ts          # Interface (GenericMessage, GenericTool, Provider)
├── anthropic.ts     # Anthropic provider (Claude)
└── openai-compat.ts # OpenAI-compatible (Ollama, LM Studio, vLLM)

src/
├── client.ts        # Provider selector
├── index.ts         # REPL loop
├── tools.ts         # Tool definitions (read_file, write_file, bash)
├── commands.ts      # Slash commands
└── ui.ts            # Colors & spinner
```

## Configuration

Edit `.env`:

```bash
# Pick: anthropic, ollama, openai-compat
PROVIDER=anthropic

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

# Ollama
OLLAMA_MODEL=llama3.2
OLLAMA_BASE_URL=http://localhost:11434/v1

# OpenAI-compatible
OPENAI_BASE_URL=http://localhost:1234/v1
OPENAI_API_KEY=lm-studio
OPENAI_MODEL=mistral-7b
```

## Development

```bash
# Install
bun install

# Run
bun run index.ts

# Type check
npx tsc --noEmit
```

## License

MIT

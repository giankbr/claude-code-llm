# Sengiku AI CLI - Quickstart

## Setup (Choose One Provider)

### Option 1: Anthropic (Default - Recommended for power)
Already configured! Just run:
```bash
bun run index.ts
```

### Option 2: Ollama (Local models - free, private)
1. Install Ollama: https://ollama.ai
2. Run a model in another terminal:
   ```bash
   ollama pull qwen2.5-coder:7b
   ollama run qwen2.5-coder:7b
   ```
3. In `.env`, set:
   ```
   PROVIDER=ollama
   OLLAMA_MODEL=qwen2.5-coder:7b
   ```
4. Run the CLI:
   ```bash
   bun run index.ts
   ```

### Option 3: OpenAI-compatible (LM Studio, vLLM, LocalAI)
1. Start your server (e.g., LM Studio at `http://localhost:1234/v1`)
2. In `.env`, set:
   ```
   PROVIDER=openai-compat
   OPENAI_BASE_URL=http://localhost:1234/v1
   OPENAI_API_KEY=lm-studio
   OPENAI_MODEL=mistral-7b
   ```
3. Run the CLI:
   ```bash
   bun run index.ts
   ```

## Features

### Chat
Type a message and press enter. Responses stream in real-time with colors:
```
> Apa itu JavaScript?
[Assistant response appears live...]
```

### Tools
The CLI can automatically use these tools when needed:
- `read_file(path)` — Read file contents
- `write_file(path, content)` — Write to a file
- `bash(command)` — Run bash commands

Try: `> read package.json` or `> run ls -la`

### Commands
- `/help` — Show available commands
- `/clear` — Clear conversation history  
- `/exit` — Exit the CLI

## Example Session

```
> Apa yang ada di folder ini?
[Tool: bash] {"command":"ls -la"}
[Result]
...file listing...

Folder ini berisi sebuah project Node.js dengan struktur...

> read the package.json
[Tool: read_file] {"path":"package.json"}
[Result]
{"name": "agent-ai-llm", ...}

Saya bisa lihat ini adalah simplified Claude Code CLI...

> /clear
Conversation history cleared.

> hello
Hi! How can I help you?
```

## Architecture

```
src/
├── providers/
│   ├── base.ts           # Provider interface (multi-provider support)
│   ├── anthropic.ts      # Anthropic provider
│   └── openai-compat.ts  # OpenAI-compatible + Ollama support
├── client.ts             # Provider selector
├── index.ts              # REPL loop, command handling
├── tools.ts              # Tool definitions and handlers
├── commands.ts           # Slash command registry
└── ui.ts                 # Color helpers and spinner
```

## Configuration (`.env`)

```bash
# Provider: anthropic, ollama, openai-compat
PROVIDER=anthropic

# Anthropic settings
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

# Ollama settings
OLLAMA_MODEL=llama3.2
OLLAMA_BASE_URL=http://localhost:11434/v1

# OpenAI-compatible settings
OPENAI_BASE_URL=http://localhost:1234/v1
OPENAI_API_KEY=lm-studio
OPENAI_MODEL=mistral-7b
```

## Tips

- **Providers are hot-swappable**: Change `PROVIDER=` in `.env` and restart to switch providers
- **System prompt**: Edit `src/providers/*.ts` to customize Claude's behavior
- **Tool timeouts**: Long bash commands may timeout. Adjust `max_tokens` in provider files if needed
- **Ollama models**: Find more at https://ollama.ai/library
- **Error messages**: In Indonesian for local development comfort 😊

## Troubleshooting

**"invalid x-api-key" error**
- Check your `ANTHROPIC_API_KEY` in `.env`
- Get one from https://console.anthropic.com

**"connection refused" for Ollama**
- Make sure `ollama run llama3.2` is running in another terminal
- Check `OLLAMA_BASE_URL` matches your Ollama server

**"connection refused" for OpenAI-compatible**
- Make sure your server (LM Studio, vLLM, etc.) is running
- Check `OPENAI_BASE_URL` is correct

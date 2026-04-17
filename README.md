# GTFO — Glean Tab For Obsidian

An agentic Obsidian plugin that connects your vault to [Glean](https://glean.com) enterprise knowledge via MCP. Chat with Glean AI, search your organization's knowledge, run commands in a full PTY terminal, and let the LLM create and organize notes in your vault — all without leaving Obsidian.

## What it does

- **Chat with Glean AI** — Ask questions about your organization. Responses render as Markdown with structured titles, formatted bodies, and action buttons. Per-message metrics show request time, token count, and response size.
- **Inline search** — `Opt`/`Alt`+`Enter` in the chat input runs a Glean search instead of chat. Results render inline in the same conversation.
- **LLM actions** — The LLM can propose vault operations (create note, edit, move, link, run command). Actions appear as buttons you execute, or run autonomously depending on your execution mode.
- **Embedded terminal** — Full PTY (xterm.js + node-pty) running in your vault directory. Run `claude`, `vim`, scripts, git, anything.
- **Debug mode** — Toggle on and every request writes a full debug note to your vault with raw response, response shape, timing, and parsed data. Terminal I/O also gets logged.
- **Node gateway** — All Node.js operations (HTTP, filesystem, processes) route through a single middleware layer that bypasses browser CORS restrictions and centralizes the browser/Node boundary.
- **Tool registry** — Every capability (Glean MCP, vault ops, shell, HTTP, filesystem) is exposed as a unified tool schema, ready for any LLM agent loop.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full system design.

```
┌────────────────────────────────────────────────────────────┐
│                      Obsidian Plugin                        │
│                                                             │
│  ┌────────────────┐        ┌─────────────────────┐          │
│  │    Chat Tab    │        │    Terminal Tab     │          │
│  │  (llmresponse  │        │  (xterm.js + fit)   │          │
│  │   rendering,   │        │                     │          │
│  │   actions,     │        │                     │          │
│  │   metrics)     │        │                     │          │
│  └───────┬────────┘        └──────────┬──────────┘          │
│          │                            │                     │
│  ┌───────┴────────────────────────────┴──────────┐          │
│  │             LLM Protocol + Parser             │          │
│  │     (bootstrap text, llmresponse schema)      │          │
│  └───────┬───────────────────────────────────────┘          │
│          │                                                   │
│  ┌───────┴───────────────────────────────────────┐          │
│  │                 Tool Registry                  │          │
│  │   Unified { name, description, params, exec } │          │
│  └───────┬───────────────────────────────────────┘          │
│          │                                                   │
│  ┌───────┴─────────────────────────────────────────────┐    │
│  │                    Node Gateway                     │    │
│  │   HTTP (no CORS) · Filesystem · Processes · Env     │    │
│  └───┬────────────┬────────────────┬──────────────┬────┘    │
│      │            │                │              │         │
│  ┌───┴──────┐ ┌───┴──────┐ ┌───────┴──────┐ ┌────┴───────┐  │
│  │ Glean MCP│ │Vault Tools│ │Terminal Mgr  │ │DebugLogger │  │
│  │  Client  │ │ CRUD+link │ │ node-pty+ptyd│ │ notes+I/O  │  │
│  └──────────┘ └───────────┘ └──────────────┘ └────────────┘  │
└────────────────────────────────────────────────────────────┘
         │
         ▼
   Glean MCP Server (OAuth 2.1 + PKCE)
```

## Quick start

### Prerequisites

- [Obsidian](https://obsidian.md) desktop app
- Node.js 18+
- A Glean account with MCP access

### Install

```bash
git clone https://github.com/your-org/gtfo.git
cd gtfo
npm install
```

### Build and link to your vault

```bash
export GTFO_VAULT=~/obsidian/your-vault

npm run rebuild-native   # compile node-pty against Obsidian's Electron
npm run build
npm run link             # symlink main.js/manifest.json/styles.css/node-pty into vault
```

### Enable in Obsidian

1. Open your vault in Obsidian
2. Settings → Community Plugins → Turn off Restricted Mode
3. Enable **Glean Tab For Obsidian**
4. Click the sparkles icon in the left ribbon to open the GTFO sidebar

### Connect to Glean

1. GTFO Settings → set your **MCP Server URL** (e.g. `https://your-company-be.glean.com/mcp/default`)
2. Choose **OAuth 2.1 + PKCE** (recommended) or **API Token**
3. Click **Connect to Glean** — authenticate via your SSO
4. You'll see "Connected to Glean (N tools available)"

OAuth tokens are persisted in the plugin's data — you won't need to reconnect after Obsidian restarts.

## Using GTFO

### Chat

Type a question and press `Enter`. Glean's LLM responds with a structured JSON envelope that the plugin parses into a title + rendered Markdown + optional actions.

**Keyboard shortcuts in the chat input:**
- `Enter` — send as chat
- `Opt`/`Alt`+`Enter` — send as **search** (results render inline as a chat message)
- `Shift`+`Enter` — newline

**Each response shows inline metrics:** `req 1.2s · 1,450 tok · 12.4KB`

**Actions:** If you say "write me a note about X", the LLM includes a `create_note` action in its response. You'll see an **Execute** button to create it. See [LLM Protocol](docs/llm-protocol.md) for all action types.

### Terminal

Full PTY shell running in your vault directory. Supports interactive programs (`vim`, `claude` CLI, `htop`, etc.), ANSI colors, tab completion, resize.

- `New` — restart the shell
- `Kill` — terminate the current process
- `Clear` — clear the screen and scrollback
- Configurable **Shell args** in settings (e.g. `-f` to skip `.zshrc` if it emits junk)

### Debug mode

Toggle **Debug mode** on in Settings → Debug. Every Glean request and terminal spawn writes a note to `gtfo-debug/` (configurable) with:

- Full raw MCP response (pretty JSON)
- Response shape analysis (keys, array lengths, string previews)
- Extracted content and parsed `llmresponse`
- Timing
- Terminal I/O log (every PTY in/out, escape-encoded)

See [Debug](docs/debug.md).

## Development

```bash
npm run dev            # Watch mode — auto-rebuilds on file changes
npm run build          # Production build
npm run link           # Symlink build output to vault
npm run rebuild-native # Recompile node-pty for Obsidian's Electron (run once, or after Obsidian updates)
```

After each change, press `Cmd+R` in Obsidian to reload the plugin.

Debug console: `Cmd+Option+I` in Obsidian opens Electron DevTools.

## Documentation

| Doc | Description |
|-----|-------------|
| [Architecture](docs/architecture.md) | System design, component diagram, data flows |
| [LLM Protocol](docs/llm-protocol.md) | Bootstrap text, `llmresponse` schema, action types, metrics, search mode |
| [Gateway](docs/gateway.md) | Node.js middleware layer — HTTP (no CORS), filesystem, processes, env |
| [Tools](docs/tools.md) | All registered tools with schemas (vault, shell, HTTP, filesystem) |
| [OAuth Flow](docs/oauth.md) | OAuth 2.1 + PKCE authentication with Glean's MCP server |
| [Debug](docs/debug.md) | Debug mode — request/response dumps and terminal I/O logging |
| [Terminal](docs/terminal.md) | PTY architecture, size-at-spawn fix, shell args, scrollback |

## Project structure

```
src/
  main.ts                      Plugin entry point, auto-reconnect, view registration
  types.ts                     Shared type definitions
  settings.ts                  Settings tab UI
  gateway/
    node-gateway.ts            Node.js middleware (HTTP, fs, processes, env)
    types.ts                   Gateway type definitions
  llm/
    protocol.ts                llmresponse schema, bootstrap text, parser
  mcp/
    client.ts                  Glean MCP client wrapper (uses gateway for fetch)
    oauth-provider.ts          OAuth 2.1 + PKCE for Obsidian
  tools/
    terminal-manager.ts        PTY lifecycle (node-pty + child_process fallback,
                               scrollback buffer, debug hook, resize guard)
    vault-tools.ts             Note CRUD, linking, cursor insertion
    tool-registry.ts           Unified tool interface for agent loops
  debug/
    debug-logger.ts            Writes request/response debug notes into the vault
  views/
    sidebar-view.ts            Main sidebar with persistent tabs (state survives
                               tab switches)
    components/
      chat-tab.ts              Chat UI, llmresponse rendering, actions, metrics,
                               search mode (Opt+Enter)
      chat-message.ts          Chat message formatting utilities
      terminal-tab.ts          xterm.js terminal, size-at-spawn fit, debounced
                               resize observer
  utils/
    note-inserter.ts           Insert/save Glean content as notes
    formatter.ts               Markdown formatting utilities
scripts/
  dev.sh                       Build + symlink to vault
  rebuild-native.sh            Auto-detect Obsidian's Electron version and rebuild
                               node-pty against it
```

## Roadmap

- [x] Chat as primary interface (search folded in via `Opt+Enter`)
- [x] Typing indicator + per-response metrics
- [x] Debug mode with request/response and terminal I/O dumps
- [x] Persistent tab state across switches
- [x] OAuth 2.1 + PKCE with auto-reconnect
- [ ] Streaming chat responses (SSE)
- [ ] Direct Glean REST API alongside MCP for richer chat support
- [ ] Note-taking workflows — templates, auto-linking, knowledge graphs
- [ ] Agent loop — plug in any LLM (Claude CLI, OpenAI, local) as the planning brain
- [ ] Multiple terminal sessions
- [ ] Inline citations from Glean chat responses

## License

MIT

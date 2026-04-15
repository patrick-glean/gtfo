# Architecture

GTFO is an Obsidian plugin built on three pillars: **Glean MCP** for enterprise knowledge, an **embedded terminal** for arbitrary tool execution, and **vault tools** for programmatic note management. A **Node Gateway** sits between the UI and all Node.js operations, keeping the browser/Node boundary clean.

## Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Obsidian Plugin                         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    GtfoSidebarView                         │  │
│  │  ┌──────────┐   ┌──────────┐   ┌───────────────────────┐  │  │
│  │  │ Search   │   │  Chat    │   │      Terminal         │  │  │
│  │  │  Tab     │   │  Tab     │   │  (xterm.js + node-pty)│  │  │
│  │  └──────────┘   └──────────┘   └───────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ LLM Protocol │  │ Tool Registry│  │   Quick Search Modal   │ │
│  │ (bootstrap,  │  │ (unified     │  │   (Cmd+Shift+G)        │ │
│  │  parser)     │  │  tool API)   │  │                        │ │
│  └──────────────┘  └──────────────┘  └────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                      Node Gateway                          │  │
│  │  ┌────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │  │
│  │  │  HTTP  │  │ Process  │  │   File   │  │ Environment │  │  │
│  │  │(no CORS│  │  spawn   │  │  System  │  │  (env, os,  │  │  │
│  │  │ fetch) │  │  exec    │  │  r/w/ls  │  │   paths)    │  │  │
│  │  └────────┘  └──────────┘  └──────────┘  └─────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ Glean MCP    │  │ Vault Tools  │  │   Terminal Manager     │ │
│  │ Client       │  │ create/read/ │  │   node-pty spawn       │ │
│  │ (StreamHTTP) │  │ edit/move/   │  │   + child_process      │ │
│  │              │  │ link/delete  │  │   fallback             │ │
│  └──────┬───────┘  └──────────────┘  └────────────────────────┘ │
│         │                                                        │
│  ┌──────┴───────┐                                                │
│  │ OAuth 2.1    │                                                │
│  │ + PKCE       │                                                │
│  │ Provider     │                                                │
│  └──────────────┘                                                │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
   Glean MCP Server (https://...glean.com/mcp/default)
```

## Data Flow

### Chat message flow

```
User types message
  → Chat Tab prepends bootstrap text (first message only)
  → GleanMCPClient.chat()
  → NodeGateway.asFetch() (bypasses CORS)
  → Glean MCP Server (POST /mcp/default)
  → Response: { content: [{ type: "text", text: "..." }] }
  → extractRawContent() pulls text
  → parseLlmResponse() extracts { title, body, actions }
  → Title rendered as header
  → Body rendered as Markdown (MarkdownRenderer)
  → Actions shown as executable buttons
```

### OAuth flow

```
User clicks "Connect to Glean"
  → GleanMCPClient.connect() with OAuthProvider
  → MCP SDK detects 401, starts PKCE flow
  → ObsidianOAuthProvider.redirectToAuthorization() opens browser
  → User authenticates via SSO
  → Glean redirects to obsidian://gtfo/oauth-callback?code=XXX
  → registerObsidianProtocolHandler catches redirect
  → transport.finishAuth() exchanges code for tokens
  → Tokens stored in plugin data
  → connectToGlean() called again with stored tokens
  → Connected
```

### Terminal flow

```
User switches to Terminal tab
  → TerminalTab creates xterm.js Terminal
  → TerminalManager.spawn() loads node-pty (or falls back to child_process)
  → PTY spawned in vault directory
  → xterm.js ↔ node-pty bidirectional data pipe
  → User types → pty.write() → shell → pty.onData() → terminal.write()
```

## Key Design Decisions

### Node Gateway pattern

All Node.js operations route through `NodeGateway` (`src/gateway/node-gateway.ts`). UI components never import `http`, `fs`, or `child_process` directly. This:

- Keeps the browser/Node boundary explicit
- Makes it trivial to add logging, rate limiting, or caching
- Provides a `fetch`-compatible wrapper (`asFetch()`) for libraries that expect the Fetch API
- Centralizes CORS bypass logic

### LLM Protocol

Rather than building a custom agent loop, the plugin uses a **bootstrap text** (system prompt) to teach Glean's LLM a structured JSON response schema. The LLM responds with `{ llmresponse: { title, body, actions } }` and the plugin parses it. This:

- Requires no separate LLM (Glean's chat IS the brain)
- Makes the protocol human-editable (settings tab)
- Allows the LLM to propose vault operations as actions
- Degrades gracefully (raw text if JSON parsing fails)

See [LLM Protocol](llm-protocol.md) for the full schema.

### Tool Registry

Every capability is registered as a `ToolDefinition` with `{ name, description, parameters, execute }`. This schema is compatible with OpenAI function calling, Anthropic tool use, and MCP tool schemas. When a real agent loop is added, it can use `toolRegistry.toFunctionSchemas()` to get the tool list and `toolRegistry.execute(name, args)` to run them.

### Terminal: PTY with fallback

The terminal uses `node-pty` for a real PTY (interactive programs, ANSI codes, tab completion). If `node-pty` fails to load (native module issues), it falls back to `child_process.spawn` with an interactive shell flag. The fallback handles most commands but can't run truly interactive programs like `vim`.

The `node-pty` module is marked `external` in esbuild and loaded at runtime from the plugin's `node_modules` directory using an absolute path (Obsidian patches `require` for plugins).

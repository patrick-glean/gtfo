# GTFO — Glean Tab For Obsidian

An agentic Obsidian plugin that connects your vault to [Glean](https://glean.com) enterprise knowledge via MCP. Search your organization's knowledge, chat with Glean AI, run commands in an embedded terminal, and let the LLM create and organize notes in your vault — all without leaving Obsidian.

## What it does

- **Chat with Glean AI** — Ask questions about your organization. Responses render as Markdown inside Obsidian with structured titles, formatted bodies, and action buttons.
- **Embedded terminal** — Full PTY terminal (xterm.js + node-pty) running in your vault directory. Run `claude`, scripts, git, anything.
- **Vault tools** — The LLM can create, edit, move, link, and organize notes programmatically. Say "write me a note about X" and it does.
- **Quick search** — `Cmd+Shift+G` opens a fast Glean search modal. Arrow keys to navigate, Enter to open, Shift+Enter to insert into your note.
- **Node gateway** — All Node.js operations (HTTP, filesystem, processes) route through a middleware layer that bypasses browser CORS restrictions.
- **Tool registry** — Every capability (Glean MCP, vault ops, shell, HTTP, filesystem) exposed as a unified tool schema, ready for any LLM agent loop.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full system design.

```
┌─────────────────────────────────────────────────┐
│                  Obsidian Plugin                 │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │  Search   │  │   Chat   │  │   Terminal    │  │
│  │   Tab     │  │   Tab    │  │  (xterm.js)   │  │
│  └────┬─────┘  └────┬─────┘  └──────┬────────┘  │
│       │              │               │           │
│  ┌────┴──────────────┴───────────────┴────────┐  │
│  │              Node Gateway                   │  │
│  │   HTTP · Filesystem · Processes · Env       │  │
│  └────┬──────────────┬───────────────┬────────┘  │
│       │              │               │           │
│  ┌────┴─────┐  ┌─────┴──────┐  ┌────┴────────┐  │
│  │ Glean MCP│  │ Vault Tools│  │ Terminal Mgr│  │
│  │  Client  │  │ (CRUD+link)│  │  (node-pty) │  │
│  └──────────┘  └────────────┘  └─────────────┘  │
└─────────────────────────────────────────────────┘
         │
         ▼
   Glean MCP Server
   (OAuth 2.1 + PKCE)
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
# Set your vault path (or edit scripts/dev.sh)
export GTFO_VAULT=~/obsidian/your-vault

# Build, rebuild native modules, and symlink to vault
npm run rebuild-native
npm run build
npm run link
```

### Enable in Obsidian

1. Open your vault in Obsidian
2. Settings → Community Plugins → Turn off Restricted Mode
3. Enable **Glean Tab For Obsidian**
4. Click the search icon in the left ribbon to open the GTFO sidebar

### Connect to Glean

1. GTFO Settings → set your **MCP Server URL** (e.g. `https://your-company-be.glean.com/mcp/default`)
2. Choose **OAuth 2.1** (recommended) or **API Token**
3. Click **Connect to Glean** — authenticate via your SSO
4. You'll see "Connected to Glean (N tools available)"

## Development

```bash
npm run dev     # Watch mode — auto-rebuilds on file changes
npm run build   # Production build
npm run link    # Symlink build output to vault
```

After each change, press `Cmd+R` in Obsidian to reload the plugin.

Debug console: `Cmd+Option+I` in Obsidian opens Electron DevTools.

### Native modules

The terminal uses `node-pty` which requires compilation against Obsidian's Electron version:

```bash
npm run rebuild-native
```

This auto-detects Obsidian's Electron version and recompiles. Re-run after Obsidian updates.

## Documentation

| Doc | Description |
|-----|-------------|
| [Architecture](docs/architecture.md) | System design, component diagram, data flow |
| [LLM Protocol](docs/llm-protocol.md) | The structured JSON response protocol between the plugin and LLM |
| [Gateway](docs/gateway.md) | Node.js middleware layer — HTTP, filesystem, process management |
| [Tools](docs/tools.md) | All registered tools with schemas (vault, shell, HTTP, filesystem) |
| [OAuth Flow](docs/oauth.md) | How authentication works with Glean's MCP server |

## Project structure

```
src/
  main.ts                      Plugin entry point
  types.ts                     Shared type definitions
  settings.ts                  Settings tab UI
  gateway/
    node-gateway.ts            Node.js middleware (HTTP, fs, processes)
    types.ts                   Gateway type definitions
  llm/
    protocol.ts                LLM response schema, bootstrap text, parser
  mcp/
    client.ts                  Glean MCP client wrapper
    oauth-provider.ts          OAuth 2.1 + PKCE for Obsidian
  tools/
    terminal-manager.ts        PTY lifecycle (node-pty + fallback)
    vault-tools.ts             Note CRUD, linking, cursor insertion
    tool-registry.ts           Unified tool interface for agent loops
  views/
    sidebar-view.ts            Main sidebar with tab navigation
    components/
      chat-tab.ts              Chat UI with structured response rendering
      search-tab.ts            Glean search with result cards
      terminal-tab.ts          xterm.js terminal emulator
      result-card.ts           Search result component
      chat-message.ts          Chat message formatting utilities
  modals/
    search-modal.ts            Quick search modal (Cmd+Shift+G)
  utils/
    note-inserter.ts           Insert/save Glean content as notes
    formatter.ts               Markdown formatting utilities
scripts/
  dev.sh                       Build + symlink to vault
  rebuild-native.sh            Recompile node-pty for Obsidian's Electron
```

## Roadmap

- [ ] Remove or rethink search tab (chat is the primary interface)
- [ ] Improve chat UX — loading indicators, progress, streaming
- [ ] Explore direct Glean REST API alongside MCP for richer chat support
- [ ] Note-taking workflows — templates, auto-linking, knowledge graphs
- [ ] Agent loop — plug in any LLM (Claude CLI, OpenAI, local) as the planning brain
- [ ] Multiple terminal sessions

## License

MIT

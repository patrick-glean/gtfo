# Tool Registry

The tool registry (`src/tools/tool-registry.ts`) provides a unified interface for all plugin capabilities. Each tool has a name, description, parameter schema, and execute function — compatible with LLM function-calling APIs (OpenAI, Anthropic, MCP).

## Registered Tools

### Vault Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `create_note` | Create a new note in the vault | `path: string`, `content: string` |
| `read_note` | Read the contents of a note | `path: string` |
| `edit_note` | Replace the contents of a note | `path: string`, `content: string` |
| `move_note` | Move or rename a note | `from: string`, `to: string` |
| `list_notes` | List notes in the vault | `folder?: string` |
| `insert_at_cursor` | Insert text at cursor in active note | `content: string` |

### Gateway Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `run_command` | Execute a shell command | `command: string`, `cwd?: string` |
| `http_request` | Make a CORS-free HTTP request | `url: string`, `method?: string`, `headers?: object`, `body?: string` |
| `read_file` | Read a file from the filesystem | `path: string` |
| `write_file` | Write a file to the filesystem | `path: string`, `content: string` |

## Relationship to LLM Actions

The [LLM protocol](llm-protocol.md) defines a separate but overlapping set of **actions** (`create_note`, `edit_note`, `move_note`, `link_notes`, `append_note`, `insert_at_cursor`, `run_command`). Actions are what the LLM proposes in its response; tools are what get executed. They share most names but are intentionally separate layers:

- **Actions** are declarative — the LLM says "this should happen" in its response JSON
- **Tools** are imperative — the plugin (or future agent loop) calls them to make things happen

When the Chat tab's `executeAction` runs, it maps action types to either `VaultTools` methods directly or tool registry calls. When a future agent loop is added, it'll use the tool registry for everything and expose `toolRegistry.toFunctionSchemas()` to the LLM.

## Schema Format

Each tool is defined as:

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}
```

`parameters` is a loose JSON-schema-compatible structure. When serialized via `toFunctionSchemas()` it matches OpenAI's function calling format:

```typescript
[
  {
    name: "create_note",
    description: "Create a new note in the vault",
    parameters: { path: { type: "string" }, content: { type: "string" } }
  },
  // ...
]
```

## Usage

### Execute a tool

```typescript
const result = await plugin.toolRegistry.execute("create_note", {
  path: "daily/2026-04-17.md",
  content: "# Today\n\nNotes go here.",
});
// → { path: "daily/2026-04-17.md" }
```

### Get schemas for LLM function calling

```typescript
const schemas = plugin.toolRegistry.toFunctionSchemas();
```

### Register a custom tool

```typescript
plugin.toolRegistry.register({
  name: "my_custom_tool",
  description: "Does something custom",
  parameters: { input: { type: "string" } },
  execute: async (args) => {
    return { result: "done" };
  },
});
```

## Vault Tools Detail

Vault tools are in `src/tools/vault-tools.ts`. They use Obsidian's API (not raw `fs`) so Obsidian's cache, link index, and UI stay in sync.

- **`createNote(path, content)`** — creates parent folders as needed
- **`readNote(path)`** — via `vault.read`
- **`editNote(path, content)`** — full content replacement via `vault.modify`
- **`appendToNote(path, content)`** — read + modify with concatenation
- **`moveNote(from, to)`** — uses `fileManager.renameFile` so backlinks update automatically
- **`deleteNote(path)`** — moves to Obsidian trash (recoverable)
- **`linkNotes(source, target)`** — appends `[[target]]` using `fileManager.generateMarkdownLink`
- **`insertAtCursor(content)`** — finds the active `MarkdownView` and inserts at cursor position
- **`listNotes(folder?)`** — returns all markdown files, optionally filtered by folder prefix

## Gateway Tools Detail

Gateway tools route through `NodeGateway`:

- **`run_command`** → `gateway.exec()` — one-shot command with stdout/stderr capture
- **`http_request`** → `gateway.http()` — CORS-free, supports all methods and body types
- **`read_file` / `write_file`** → `gateway.readFile()` / `writeFile()` — can access files outside the vault (use with care)

See [Gateway](gateway.md) for the underlying API.

## Adding an Action-to-Tool Bridge

If you add a new action type to the LLM protocol, you also need to add execution logic in `src/views/components/chat-tab.ts` `executeAction`. For best results, register a matching tool so the future agent loop can invoke it via function calling:

```typescript
// In main.ts registerVaultTools():
this.toolRegistry.register({
  name: "my_action",
  description: "Does the thing",
  parameters: { /* ... */ },
  execute: async (args) => { /* ... */ },
});

// In chat-tab.ts executeAction():
case "my_action":
  if (action.someField) {
    await this.plugin.toolRegistry.execute("my_action", {
      someField: action.someField,
    });
  }
  break;
```

Then teach the LLM about it by editing the bootstrap text.

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

## Usage

### Execute a tool

```typescript
const result = await plugin.toolRegistry.execute("create_note", {
  path: "daily/2026-04-14.md",
  content: "# Today\n\nNotes go here.",
});
```

### Get schemas for LLM function calling

```typescript
const schemas = plugin.toolRegistry.toFunctionSchemas();
// [{ name: "create_note", description: "...", parameters: {...} }, ...]
```

### Register a custom tool

```typescript
plugin.toolRegistry.register({
  name: "my_custom_tool",
  description: "Does something custom",
  parameters: { input: { type: "string" } },
  execute: async (args) => {
    // your logic here
    return { result: "done" };
  },
});
```

## Vault Tools Detail

Vault tools use the Obsidian API (`src/tools/vault-tools.ts`):

- **createNote** — creates parent folders automatically
- **editNote** — full content replacement
- **appendToNote** — appends to existing content
- **moveNote** — uses `fileManager.renameFile` for proper link updates
- **deleteNote** — moves to Obsidian trash
- **linkNotes** — generates a markdown link using `fileManager.generateMarkdownLink`
- **insertAtCursor** — finds the active `MarkdownView` and inserts at cursor position
- **listNotes** — returns all markdown files, optionally filtered by folder

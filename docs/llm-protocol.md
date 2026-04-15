# LLM Protocol

The LLM protocol defines the structured communication between the GTFO plugin and any LLM (currently Glean's chat). The plugin sends a **bootstrap text** with the first message that teaches the LLM how to respond. Responses are parsed and rendered as rich UI with optional executable actions.

## Response Schema

Every LLM response must be a JSON object:

```json
{
  "llmresponse": {
    "title": "Short title (5-10 words)",
    "body": "Full response in Markdown format",
    "actions": []
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Brief heading for the response card |
| `body` | string | yes | Markdown content, rendered in Obsidian |
| `actions` | array | no | Vault operations to propose or execute |

## Actions

Actions are vault operations the LLM proposes. Depending on the execution mode setting, they're either auto-executed or shown as buttons for user confirmation.

### create_note

```json
{"type": "create_note", "path": "folder/name.md", "content": "full markdown"}
```

Creates a new note. The `content` should be standalone (including any frontmatter). The `path` is relative to the vault root.

### edit_note

```json
{"type": "edit_note", "path": "existing.md", "content": "new full content"}
```

Replaces the entire content of an existing note.

### append_note

```json
{"type": "append_note", "path": "existing.md", "content": "content to append"}
```

Appends content to the end of an existing note.

### insert_at_cursor

```json
{"type": "insert_at_cursor", "content": "text to insert"}
```

Inserts text at the cursor position in the currently active note.

### move_note

```json
{"type": "move_note", "path": "old/path.md", "targetPath": "new/path.md"}
```

Moves or renames a note.

### link_notes

```json
{"type": "link_notes", "path": "source.md", "targetPath": "target.md"}
```

Appends a `[[target]]` link to the source note.

### run_command

```json
{"type": "run_command", "command": "shell command to execute"}
```

Runs a shell command and shows the result.

## Execution Modes

Configurable in Settings → Agent Behavior → Execution mode:

| Mode | Behavior |
|------|----------|
| **Autonomous** | Actions execute immediately without confirmation |
| **Plan & Confirm** | Actions shown as buttons — user clicks to execute (default) |
| **Step-by-step** | Same as Plan & Confirm (future: confirm each action individually) |

## Bootstrap Text

The bootstrap text is a system prompt prepended to the first message in each chat conversation. It teaches the LLM the response schema and action triggers. Editable in Settings → Agent Behavior → Bootstrap text.

The default bootstrap text is defined in `src/llm/protocol.ts` as `DEFAULT_BOOTSTRAP`.

### Trigger phrases

The bootstrap instructs the LLM to include a `create_note` action when it detects phrases like:

- "write me a note about..."
- "create a note..."
- "save this as a note..."
- "make a note on..."

## Parser

`parseLlmResponse()` in `src/llm/protocol.ts` parses the response with multiple strategies:

1. Direct JSON parse of the trimmed response
2. Extract JSON from markdown code blocks (` ```json ... ``` `)
3. Find the first `{` to last `}` substring and parse
4. Fallback: return `{ title: "Response", body: rawText }` so unstructured responses still render

## Customization

Edit the bootstrap text to:

- Change the response schema (add fields, change format)
- Add new action types
- Change trigger phrases
- Add context about your vault structure ("notes go in `projects/` folder")
- Include team conventions or templates

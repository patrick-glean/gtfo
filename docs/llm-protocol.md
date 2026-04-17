# LLM Protocol

The LLM protocol defines structured communication between GTFO and the LLM (currently Glean's MCP chat). A **bootstrap text** is sent with the first message to teach the LLM a response schema. The plugin parses responses into rich UI with optional executable actions.

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
| `title` | string | yes | Rendered as a header above the body |
| `body` | string | yes | Markdown, rendered with Obsidian's MarkdownRenderer |
| `actions` | array | no | Vault operations to propose or execute |

## Modes

The chat input supports two modes:

| Shortcut | Mode | Behavior |
|----------|------|----------|
| `Enter` | **Chat** | Full conversation with Glean AI. Bootstrap text sent on first message, subsequent messages reuse the `chatId`. |
| `Opt`/`Alt` + `Enter` | **Search** | Glean search over the knowledge index. Results render inline as a chat message (prefixed with 🔍). No bootstrap text, no LLM — just indexed results. |
| `Shift` + `Enter` | — | Newline in the input |

Search results are wrapped in an `llmresponse` envelope so the same rendering pipeline handles them. The title shows the query and result count; the body is a Markdown list of results.

## Metrics

Every assistant message displays inline metrics next to the role label:

```
GLEAN                           req 1.2s · 1,450 tok · 12.4KB
```

| Metric | Source |
|--------|--------|
| `req` | Wall-clock round-trip time (`performance.now()` bracketing the MCP call) |
| `tok` | Rough estimate: `length / 4` on the extracted content |
| `bytes` | `Blob.size` of the full JSON response |

`tok` is only an estimate since we don't receive token counts from Glean. When streaming is added, we'll also track TTFT (time to first token).

## Actions

Actions are vault operations the LLM proposes. Depending on the **execution mode** setting, they're auto-executed or shown as buttons for user confirmation.

### create_note

```json
{"type": "create_note", "path": "folder/name.md", "content": "full markdown"}
```

The `content` should be standalone (frontmatter optional). `path` is relative to the vault root. Parent folders are created automatically.

### edit_note

```json
{"type": "edit_note", "path": "existing.md", "content": "new full content"}
```

Replaces the entire content of an existing note.

### append_note

```json
{"type": "append_note", "path": "existing.md", "content": "content to append"}
```

### insert_at_cursor

```json
{"type": "insert_at_cursor", "content": "text to insert"}
```

Inserts at the cursor position in the currently active note.

### move_note

```json
{"type": "move_note", "path": "old/path.md", "targetPath": "new/path.md"}
```

Uses `fileManager.renameFile` so backlinks update automatically.

### link_notes

```json
{"type": "link_notes", "path": "source.md", "targetPath": "target.md"}
```

Appends a `[[target]]` link to the source note.

### run_command

```json
{"type": "run_command", "command": "shell command"}
```

Runs a shell command via the Node Gateway. Shown to the user via a Notice with the exit code.

## Execution Modes

Configurable in Settings → Agent Behavior → Execution mode:

| Mode | Behavior |
|------|----------|
| **Autonomous** | Actions execute immediately without confirmation |
| **Plan & Confirm** | Actions shown as `Execute` buttons — user clicks each (default) |
| **Step-by-step** | Currently same as Plan & Confirm; future: confirm with inline diff preview |

## Bootstrap Text

The bootstrap text is a system prompt prepended to the first message in each chat conversation. It teaches the LLM the response schema and action triggers. Editable in Settings → Agent Behavior → Bootstrap text (with a "Reset to default" button).

The default is defined in `src/llm/protocol.ts` as `DEFAULT_BOOTSTRAP`. It tells the LLM:

- Always respond with valid JSON
- Use the `llmresponse` schema exactly
- Only include actions when the user asks for a vault operation
- Trigger phrases for `create_note`: "write me a note about...", "create a note...", "save this as a note...", "make a note on..."
- The action's `content` should be complete standalone note content, separate from the conversational `body`

## Runtime Context

The LLM doesn't know today's date, the local time, or the name of your vault. Without that, when asked to create time-sensitive notes (e.g. "write a note about my 2:30 meeting") it tends to emit Templater-style placeholders like `{{date:YYYY-MM-DD}}` — and those land in your file verbatim because GTFO doesn't run Obsidian's template engine.

To prevent that, `buildRuntimeContext()` is prepended to **every** outgoing chat message (not just the first), so the anchor stays correct even across day boundaries:

```
(gtfo runtime: today is 2026-04-17 (Friday); local time 15:48 America/Los_Angeles; vault "my-vault". When a note needs a date or time, write the actual value -- never emit template placeholders like {{date}} or {{date:YYYY-MM-DD}}.)
```

On the first message of a conversation this sits between the bootstrap and the user's turn; on subsequent messages it's prepended to the user's text. It's deliberately parenthetical so the LLM treats it as meta context.

## Template Placeholder Expansion

As a defensive fallback, `expandTemplatePlaceholders()` runs on any LLM-generated content before it hits disk — covering the `create_note` / `edit_note` / `append_note` / `insert_at_cursor` actions, the "Save as Note" button, and "Insert to Note". This catches cases where the LLM ignores the runtime context, or where a user's customized bootstrap stripped it out.

Supported placeholders:

| Placeholder | Expansion |
|-------------|-----------|
| `{{date}}` | Today, default format `YYYY-MM-DD` |
| `{{date:FORMAT}}` | Today formatted with `FORMAT` |
| `{{time}}` | Now, default format `HH:mm` |
| `{{time:FORMAT}}` | Now formatted with `FORMAT` |
| `{{title}}` | Filename of the target note (no `.md`) |

Supported format tokens (moment.js-compatible subset): `YYYY`, `YY`, `MMMM`, `MMM`, `MM`, `M`, `DD`, `D`, `dddd`, `ddd`, `HH`, `H`, `mm`, `m`, `ss`, `s`. Unknown tokens pass through unchanged.

Any other `{{...}}` expression (e.g. full Templater syntax like `<% tp.date.now() %>`) is **not** touched — it stays visible so you can notice and fix the prompt, rather than being silently dropped.

## Parser

`parseLlmResponse` in `src/llm/protocol.ts` parses the response with multiple strategies, in order:

1. Direct JSON parse of the trimmed text
2. Extract JSON from Markdown code blocks (` ```json ... ``` `)
3. Find the first `{` to last `}` substring and parse
4. Fallback: return `{ title: "Response", body: rawText }` — unstructured responses still render

### Extracting from Glean MCP's nested response

Glean's MCP chat tool wraps the LLM output in a YAML-serialized chat API response inside the standard MCP `content[].text` field. `extractRawContent` in `chat-tab.ts` handles this by searching for `"llmresponse"` in the full text and extracting the balanced `{...}` region containing it — walking the string character by character, respecting string escaping, counting braces. Both escaped (`\"llmresponse\"`) and unescaped (`"llmresponse"`) forms are supported.

If your Glean tenant returns a different response shape, turn on debug mode and check `docs/debug.md` — the debug note will show the exact structure and we can update the parser.

## Customization

Edit the bootstrap text to:

- Change the response schema (add fields, change format)
- Add new action types (you'll also need to add a matching handler in `chat-tab.ts` `executeAction`)
- Change trigger phrases
- Add context about your vault structure ("notes go in `projects/` folder")
- Include team conventions or templates

Remember: the bootstrap text is sent with **every first message** of a conversation, so keep it concise.

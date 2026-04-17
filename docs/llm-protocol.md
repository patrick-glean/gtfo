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
| **Plan & Confirm** | Actions shown as `Execute` buttons — user clicks each, or `Execute all` to run the full batch (default) |
| **Step-by-step** | Currently same as Plan & Confirm; future: confirm with inline diff preview |

### Batched execution

A single LLM response may include many actions in one `actions` array — for example, "organize my vault" can return 30+ `move_note` proposals at once. The actions block in the chat UI shows:

- One `Execute` button per row (review and run individually).
- An `Execute all (N)` button at the top whenever there are 2+ actions. It runs every not-yet-executed action sequentially, updates each row to `Done` or `Failed` as it goes, and finishes with a summary like `Done — 28 ok, 2 failed`. Already-executed rows are skipped, so it's safe to mix manual + batch execution.

Failures don't halt the batch — the loop continues so one bad path doesn't strand the rest.

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

## Vault Listing

When **Settings → Vault Context → Include vault listing in chat context** is on (default), `buildVaultListing()` is appended to the runtime block on every chat message. It gives the LLM a compact, authoritative inventory of your notes so it can:

- Resolve approximate names ("edit my 2:30 meeting note") to real paths.
- Propose `move_note` actions when you ask it to organize, clean up, or sort your vault.
- Avoid inventing paths that don't exist.

### Source

The listing is built from two Obsidian APIs that are already populated and kept fresh:

| API | What we use |
|-----|-------------|
| `app.vault.getMarkdownFiles()` | All markdown files in the vault, excluding `.obsidian/` etc. |
| `app.metadataCache.getFileCache(file)` | Parsed frontmatter, inline `#tags`, headings — the same index that powers Graph View, the tag pane, and backlinks |

### Shape

```
Vault listing (my-vault) — 47 notes. Use these vault-relative paths verbatim (including the .md extension) when proposing edit_note / move_note / append_note / link_notes actions:
- README.md
- daily/2026-04-17.md
- meetings/Meeting - 2_30 PM Today.md  "Meeting - 2:30 PM Today"  #meeting #work
- meetings/Q2 kickoff.md  #meeting #planning
- projects/Acme Redesign.md  #project #acme
```

Each line is one full vault-relative path with the `.md` extension. Optional fields after two-space separators: a quoted H1 (only when it adds signal beyond the filename) and a list of `#tag` tokens (inline + frontmatter, deduped).

The format is deliberately flat rather than tree-grouped. Tree formatting is more compact but forces the LLM to reconstruct paths from indented filenames + parent folders, which is fragile when filenames contain dashes or spaces (e.g. `Meeting - 2_30 PM Today.md`). The LLM gets told in the bootstrap to copy paths verbatim — never split, never strip.

### Exclusions

- The debug folder (`settings.debugFolder`) is **always** excluded — its notes are GTFO's own output and would balloon the context on every turn.
- Additional user-configurable exclusions via `settings.vaultListingExcludes` (comma-separated folder prefixes).

### Token budget

The full listing is capped at `settings.vaultListingMaxChars` (default 6000, roughly 1500 tokens). When a vault is too big to fit, the listing gracefully degrades to a folder-only summary with counts so the LLM can still reason about structure.

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

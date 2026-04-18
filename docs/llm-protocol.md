# LLM Protocol

The LLM protocol defines what GTFO expects from Glean's chat responses. A **bootstrap text** is sent with the first message of every chat. The protocol is deliberately lightweight: the LLM responds in **natural Markdown**, and only when a vault operation is requested does it append a fenced JSON block describing those operations.

## Response Shape

Glean's reply is rendered as Markdown directly into the chat panel — no JSON envelope, no title field, no special schema. The LLM writes the way it would in any chat: prose, headings, lists, code blocks, callouts, etc. Inline citations come through Glean's own response structure (we don't have to reconstruct them).

## Obsidian Metadata Block

At the end of every substantive reply, the LLM appends ONE fenced code block tagged `obsidian_metadata` containing a JSON object that describes the reply:

````markdown
I'll create a planning note for tomorrow.

```obsidian_metadata
{
  "title": "Tomorrow's Planning Session",
  "tags": ["planning", "meetings", "2026-04"],
  "summary": "Outline for the planning meeting with agenda and pre-reads.",
  "actions": [
    {
      "type": "create_note",
      "path": "meetings/2026-04-19 planning.md",
      "content": "# Planning\n\n..."
    }
  ]
}
```
````

All four fields are optional but `title` and `tags` are strongly recommended — they let "Save as Note" and downstream features work without a follow-up LLM call to figure out what to call the note.

| Field | Purpose |
|---|---|
| `title` | Recommended note title (5-10 words). Used as the filename slug + H1 on Save-as-Note. |
| `tags` | Recommended tags (no leading `#`). Rendered as pills under the message and dropped into frontmatter on save. |
| `summary` | Optional 1-2 sentence summary. Goes into frontmatter as `summary:` on save. |
| `actions` | Vault / shell operations to propose. Rendered as Execute buttons. |

The plugin's `extractObsidianMetadata` finds the block and parses the JSON; `stripMetadataBlock` removes it from the body before rendering, so the user never sees the raw JSON. The parser tolerates a few common drift modes (tags as a comma-separated string, tags with leading `#`, single action object instead of array, unknown fields, malformed JSON returns `{}`).

### Why a separate block (and not a JSON envelope around the body)

The previous design wrapped every response in `{"llmresponse": {"title", "body", "actions"}}`. That broke two ways:

1. **Glean's agent splits text fragments around inline citations.** Each text fragment carried a piece of the LLM's JSON, with `citation` fragments interleaved. No single fragment was parseable JSON — we had to stitch them back together, and any whitespace mismatch broke the parse.
2. **Citation positioning was lost.** The LLM body was a string inside a JSON, so Glean's per-fragment citation markers couldn't map back to character positions in our rendered markdown.

The new design lets Glean stream natural markdown the way it wants to. Citations come through unchanged. The metadata block is small, append-only, easy to parse with a single regex, and stripped before render.

### Save-as-Note example

Given the metadata above, clicking **Save as Note** writes:

```markdown
---
source: glean
date: 2026-04-18
tags:
  - planning
  - meetings
  - 2026-04
summary: "Outline for the planning meeting with agenda and pre-reads."
---

# Tomorrow's Planning Session

…body…
```

The Save button's tooltip previews this — `Save as "Tomorrow's Planning Session"` / `Tags: #planning #meetings #2026-04` — so the user can confirm before clicking.

## Modes

The chat input supports two modes:

| Shortcut | Mode | Behavior |
|----------|------|----------|
| `Enter` | **Chat** | Full conversation with Glean AI. Bootstrap text sent on first message, subsequent messages reuse the `chatId`. |
| `Ctrl` + `Enter` | **Search** | Glean search over the knowledge index. Results render inline as a chat message (prefixed with 🔍). No bootstrap text, no LLM — just indexed results. `Cmd` and `Opt` are accepted as macOS-friendly alternatives. |
| `Shift` + `Enter` | — | Newline in the input |

Search results are formatted as a Markdown bullet list and rendered inline. The metrics line shows the result count (`5 results`) instead of an estimated token count — there are no real tokens for a search.

## Request Lifecycle — Timeout, Progress, Cancel

Long Glean chats can easily exceed the MCP SDK's 60s default timeout. GTFO exposes three knobs around this and a live UI to match:

| Setting | Default | Effect |
|---------|---------|--------|
| `mcpRequestTimeoutMs` | 180s | Per-request timeout. Raise if your tenant's chats run longer. |
| `mcpResetTimeoutOnProgress` | on | Each progress notification from the server restarts the timeout clock. Keeps streamed chats from hard-timing-out between updates. |
| Cancel button | — | Aborts the in-flight request via `AbortController`. The SDK forwards the cancellation to the server and throws an `AbortError` that we catch and render as `_Cancelled._`. |

### While the request is in flight

The loading bubble shows three things that update in place (no re-renders):

1. **Status line** — rotates through phrases every 2.5s (`Query in flight…` → `Consulting the knowledge base…` → `Recommending best approach…` → …). Chat and search use separate phrase lists.
2. **Elapsed readout** — `0.3s`, `15.2s`, `2m 14s` — ticks every 1s.
3. **Cancel button** — one click aborts.

If the server emits a progress notification with a `message` field, the rotating phrase is replaced by the server's actual status and stays pinned there until the next progress update (or completion).

The Send button shows `Sending…` and is disabled while a request is in flight — only one at a time. Hit Cancel to free it up if you want to re-send.

### Error paths

| Kind | Renders as | When |
|------|-----------|------|
| `cancelled` | `_Cancelled._` | User clicked Cancel |
| `timeout` | Hint pointing at the timeout setting + reset-on-progress toggle | `McpError` with code `-32001` or a message matching `requesttimeout` / `timed out` |
| `other` | `**Error:** <message>` | Anything else — transport, auth, protocol |

All three are logged to the debug note (when debug mode is on) with the raw error string and the classified kind.

## Metrics

Every assistant message displays inline metrics next to the role label — success or failure:

```
GLEAN                           req 1.2s · 1,450 tok · 12.4KB
SEARCH                          req 0.8s · 12 results · 8.4KB
GLEAN                           req 180s · timeout
GLEAN                           req 8.2s · cancelled
```

| Metric | Source |
|--------|--------|
| `req` | Wall-clock round-trip time (`performance.now()` bracketing the MCP call). Always shown, even on error. |
| `tok` | Chat-mode only. Rough estimate: `length / 4` on the rendered body. Omitted on error. |
| `results` | Search-mode only. Number of results returned by Glean. Omitted on error. |
| `bytes` | `Blob.size` of the full JSON response. Omitted on error. |
| `cancelled` / `timeout` / `other` | Error kind from `classifyMcpError`. Only shown on failed responses. |

`tok` is only an estimate since we don't receive token counts from Glean. Search mode shows `results` instead — there's no meaningful "tokens" value for a search response.

### Persistent usage stats

Successful requests and executed actions are accumulated into persistent counters stored alongside the plugin's settings (`plugin.saveData`). These are visible at **Settings → Usage Stats** and include:

- Chat / Search request counts
- Cancelled / Timed out / Failed counts
- Avg and total response time, total estimated tokens, total bytes
- Notes created / edited / moved / linked, cursor inserts, shell commands run

A **Reset** button zeros everything out and sets the "tracking since" timestamp to the reset moment. Stats writes are debounced 500ms so an `Execute all` batch of 30 actions doesn't cause 30 disk writes.

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

The bootstrap text is a system prompt prepended to the first message in each chat conversation. Editable in Settings → Agent Behavior → Bootstrap text (with a "Reset to default" button).

The default is defined in `src/llm/protocol.ts` as `DEFAULT_BOOTSTRAP`. It tells the LLM:

- Respond in **natural Markdown** (no JSON envelope)
- Append exactly one fenced `obsidian_metadata` JSON block at the END of every reply, with optional `title`, `tags`, `summary`, and `actions`
- Strongly recommend including `title` (5-10 words, title-case) and `tags` (2-5 short lowercase tags, no `#` prefix) on every substantive reply
- Use `actions` only when the user explicitly asks for a vault operation
- Trigger phrases for `create_note`: "write me a note about...", "create a note...", "save this as a note...", "make a note on..."
- Action `content` should be complete standalone note content (with frontmatter if appropriate)
- For organize-vault requests, propose many `move_note` actions in one block — the user has an Execute all button

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

The parser is intentionally minimal:

1. `assembleMarkdownFromContent` finds the last `messageType: CONTENT` block in Glean's YAML response wrap, regex-matches every `text: "..."` fragment within it, decodes each, and concatenates them in order. The result is the LLM's natural-markdown reply.
2. `extractObsidianMetadata` scans the body for an ` ```obsidian_metadata ... ``` ` fenced block and JSON.parses its payload as an `ObsidianMetadata` object (`{ title?, tags?, summary?, actions? }`).
3. `stripMetadataBlock` removes that fenced block from the body before rendering, so the user never sees the raw JSON.

There's no JSON envelope to find, no balanced-brace walking, no multi-strategy fallback chain — Glean's response is markdown, we render it as markdown, and the only structured contract is the appended metadata block.

### Glean's response shape

The MCP `content[0].text` field carries a YAML-like dump of Glean's chat API response. For agent-style queries that hit multiple tools (e.g. "who is on my team?" triggering Employee Search + Glean Search) the YAML carries a `messages[N]:` array with several intermediate `messageType: UPDATE` entries and one final `messageType: CONTENT` entry that holds the answer.

The CONTENT message's `fragments[]` array interleaves text chunks with `citation` blocks and `{}` separators:

```
fragments[8]:
  - text: "I can't see your team roster directly..."
  - {}
  - citation: { sourceDocument: { ... }, referenceRanges: [...] }
  - text: " ...continues here..."
  - citation: { sourceDocument: { ... } }
  - text: "...closes here."
```

We just concatenate the `text` fragments in order. The citations are extracted separately into the Sources panel.

### Sources (document citations)

The same YAML wrap contains a list of `structuredResults` (the documents Glean retrieved) and `- citation:` blocks (the documents the LLM actually cited, with `referenceRanges[].snippets[]` direct-quote snippets). `extractSourcesFromText` merges both into one list, deduped by URL. Documents that appeared in a `- citation:` block are marked `cited: true` with their snippets attached, so the UI sorts them first and shows the direct quotes inline.

If your Glean tenant returns a different response shape, turn on debug mode and check `docs/debug.md` — the debug note will show the exact structure and we can update the parser.

## Customization

Edit the bootstrap text to:

- Change the response schema (add fields, change format)
- Add new action types (you'll also need to add a matching handler in `chat-tab.ts` `executeAction`)
- Change trigger phrases
- Add context about your vault structure ("notes go in `projects/` folder")
- Include team conventions or templates

Remember: the bootstrap text is sent with **every first message** of a conversation, so keep it concise.

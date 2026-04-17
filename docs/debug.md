# Debug Mode

GTFO has a built-in debug mode that captures every Glean request and terminal interaction as a note in your vault. This makes it possible to diagnose issues (parsing errors, bad response shapes, terminal artifacts) **from inside Obsidian itself** — no DevTools required, and you can share debug notes with a teammate or paste them into an issue.

## Enabling

Settings → **Debug**:

- **Debug mode** (toggle) — turns logging on/off
- **Debug folder** — where notes are written (default: `gtfo-debug`)

Changes take effect immediately. You don't need to reload.

## Chat/Search Debug Notes

Every chat or search request writes a note at:

```
<debug-folder>/<timestamp>__<mode>__<slug>.md
```

Example: `gtfo-debug/2026-04-17_07-55-12-000__chat__write-me-a-note-about-ai-models.md`

### Contents

```yaml
---
source: gtfo-debug
mode: chat
tool: chat
timestamp: 2026-04-17T07:55:12.000Z
req_ms: 1247
---
```

Sections:

1. **Request** — the prompt text, any arguments passed to the MCP tool, the current `chatId`
2. **Timing** — total request duration
3. **Raw MCP Response** — full `JSON.stringify(response, null, 2)`. Large but exhaustive.
4. **Response Shape** — structural description showing every key, array length, and string preview. Much easier to read than the raw JSON when you're trying to figure out where data lives.
5. **Extracted Content** — what `extractRawContent` pulled out of the raw response
6. **Parsed llmresponse** — the final `{ title, body, actions }` object (if parsing succeeded)
7. **Error** — stack trace if the request threw

### Response Shape

The shape analysis is useful for quickly understanding a nested response. Example:

```text
Object (keys: content, messages, chatId)
  content:
    Array (3 items):
      [0]:
        Object (keys: type, text)
          type:
            string (4 chars): "text"
          text:
            string (2142 chars): "chatId: d5730b...\nmessages[1]:\n  -\n..."
      [1]:
        Object (keys: type, resource)
          ...
  messages:
    Array (1 items):
      [0]:
        Object (keys: author, fragments, messageId)
          ...
```

If the parser is failing to extract the llmresponse, the shape tells you where it actually lives so you can update `extractRawContent` in `src/views/components/chat-tab.ts`.

## Terminal Debug Log

When debug mode is on, a terminal log note is created on plugin load:

```
<debug-folder>/<timestamp>__terminal.md
```

Every PTY operation writes to this note:

- **Spawn** — shell path, args, cwd, initial size, transport (node-pty vs child_process)
- **`in:`** — JSON-escaped input (every byte the user types)
- **`out:`** — JSON-escaped output (every byte the shell emits)
- **`resize:`** — dimension changes (only when they actually change)
- **`exit:`** — exit code

Writes are debounced at 250ms to avoid vault thrashing during busy shell I/O. Everything is escape-encoded (`\u001b` for ESC, `\r\n` for newlines, etc.) so you can see the raw bytes — essential for diagnosing escape sequence issues.

### Example

```text
=== shell spawn @ 2026-04-17T07:55:12.689Z ===
shell: /bin/zsh
args:  []
cwd:   /Users/patrick/obsidian/vault
size:  70x52
transport: node-pty

out: "\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m      [...spaces...]  \r \r"
out: "\r\u001b[0m\u001b[27m\u001b[24m\u001b[J(env) user@host vault % \u001b[K\u001b[?2004h"
in:  "l"
in:  "s"
in:  "\r"
out: "ls\r\n"
out: "README.md\r\nsrc\r\n"
out: "(env) user@host vault % "
```

This makes it obvious when the shell is sending malformed sequences, when resize storms are happening, or when a shell integration script is doing something unexpected.

## Common Diagnostics

### "My response isn't parsing"

1. Toggle debug mode on
2. Send the problematic chat message
3. Open the generated debug note
4. Check **Response Shape** — find where the llmresponse lives
5. Check **Extracted Content** — is it what you expect?
6. If extraction is wrong, look at **Raw MCP Response** and update `extractRawContent` accordingly

### "My terminal has weird artifacts"

1. Toggle debug mode on
2. Reproduce the artifacts
3. Open the terminal debug log note
4. Search for the moment the artifacts appeared
5. Check the raw `out:` bytes around that point — are they well-formed escape sequences, or malformed ones?
6. Also try **Shell args: `-f`** to skip `.zshrc` — often the culprit is a shell integration script

### "My connection fails"

1. Toggle debug mode on (note: connection errors log to the DevTools console, not debug notes, since there's no response to log)
2. Try to connect
3. Check DevTools: `Cmd+Option+I` → Console tab
4. GTFO logs connection attempts with a `[GTFO]` prefix

## Housekeeping

Debug notes accumulate fast. Periodically clean up the `gtfo-debug/` folder. You can:

- Use Obsidian's file navigator to delete old ones
- Use Dataview to query and bulk-delete by frontmatter (`source: gtfo-debug` and `timestamp < X`)
- Add `gtfo-debug/` to `.gitignore` if you sync your vault to git

Debug notes include frontmatter (`source: gtfo-debug`, `mode`, `timestamp`, `req_ms`, `error`) so they're queryable with Dataview.

## Privacy

Debug notes contain **full request content and response data** including:

- Your chat prompts (may contain sensitive questions)
- Glean's responses (may contain internal documents, emails, etc.)
- Terminal I/O (may contain credentials, secrets you type)

Treat debug notes like production logs. Don't share them without redaction, and don't sync the debug folder to any public location.

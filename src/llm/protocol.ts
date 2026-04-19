/**
 * GTFO ↔ LLM protocol.
 *
 * The LLM responds in NATURAL Markdown — same as it would in a normal
 * chat. We don't wrap responses in a JSON envelope; that turned out to
 * fight Glean's response shape (the agent splits text fragments around
 * inline citations, which made envelope-style JSON unparseable across
 * fragments and erased citation positioning).
 *
 * The only structured contract: optionally append ONE fenced code
 * block at the END of the reply, tagged `obsidian_metadata`,
 * containing a JSON object with any of these optional fields:
 *
 *   { "title", "tags", "summary", "actions" }
 *
 * The plugin parses the block, strips it from the rendered body, and
 * uses the structured fields for things like Save-as-Note (title +
 * tags) and the action panel (actions). All fields are optional.
 */

import type { LlmAction, ObsidianMetadata, VaultEntry } from "../types";

export type { LlmAction, ObsidianMetadata } from "../types";

export const DEFAULT_BOOTSTRAP = `You are running inside an Obsidian plugin called GTFO (Glean Tab For Obsidian). Your reply renders as Markdown directly into a chat panel — write naturally, like you would in any chat. Use headings, lists, code blocks, callouts, links, etc.

OBSIDIAN_METADATA: At the END of your reply, append ONE fenced code block tagged \`obsidian_metadata\` containing a JSON object describing the reply:

\`\`\`obsidian_metadata
{
  "title": "Short note title (5-10 words)",
  "tags": ["one-or-two-word", "lowercase-tags"],
  "summary": "Optional 1-2 sentence summary of the answer.",
  "actions": []
}
\`\`\`

All fields are OPTIONAL but you should normally include "title" and "tags" — the plugin uses them when the user clicks Save as Note (without them we have to guess from the prose). Use "actions" only when the user explicitly asks for a vault operation.

Field guidance:
- "title": title-case, 5-10 words, summarizes what the answer is about.
- "tags": 2-5 short lowercase tags (no leading #). Match existing vault tags from the Vault listing when reasonable.
- "summary": one or two sentences, standalone (don't start with "this is about…").
- "actions": vault / shell operations — see ACTION SHAPES below. Omit the field (or use an empty array) when no operations are needed.

ACTION SHAPES (path is vault-relative, includes the .md extension):
- {"type": "create_note", "path": "folder/name.md", "content": "full markdown"}
- {"type": "edit_note", "path": "existing.md", "content": "new full content"}
- {"type": "append_note", "path": "existing.md", "content": "content to append"}
- {"type": "insert_at_cursor", "content": "text to insert at cursor"}
- {"type": "move_note", "path": "old/path.md", "targetPath": "new/path.md"}
- {"type": "link_notes", "path": "source.md", "targetPath": "target.md"}
- {"type": "run_command", "command": "shell command to execute"}

Trigger phrases that MUST populate "actions" with a create_note (a NEW note):
- "write me a note about..."
- "create a note..."
- "save this as a note..."
- "make a note on..."

Trigger phrases that MUST populate "actions" with an edit_note against the OPEN FILE (only when an Open file block is present in the runtime context):
- "rewrite this..." / "rewrite the note..." / "rewrite my note..."
- "reword this..." / "reword it..."
- "write this like a <tone/style>" (e.g. "write this like a pirate", "write this more formally")
- "make this <tone>" (e.g. "make this funnier", "make this shorter")
- "change the tone of this..."
- "edit this..." / "fix this up..." / "clean this up..."
- "update this note..." (when not clearly asking for an append)
- any ask that means "apply a revision to what I'm looking at"

Trigger phrases that MUST populate "actions" with one or more move_note operations (against paths from the Vault listing):
- "organize my notes" / "organize this vault" / "organize <folder>"
- "clean up my notes" / "tidy up..." / "reorganize..."
- "shuffle..." / "reshuffle..." / "rearrange..."
- "move <X> to <Y>" / "put <X> under <Y>" / "relocate <X>"
- "I don't want anything under <folder>" / "get rid of <folder>" / "flatten <folder>"
- "consolidate <X>"
- "split <X> into <Y> and <Z>"

Negative-space interpretation: when the user says "I don't want X under Y" or "stop putting things in Z", that is a request to MOVE existing notes out of Y/Z, not just "don't add more in the future". Propose move_note actions for every existing file under the named folder.

The action's "content" field should be complete standalone note content (with frontmatter if appropriate), not a reference to your prose. The fenced block is for the plugin only and is stripped from the message before rendering — don't repeat its content in your prose.

VAULT LISTING: When a "Vault listing" block is in the runtime context, treat it as the inventory of the user's vault. Each line is: a leading "- ", then the full vault-relative path (which includes the .md extension and may contain spaces and dashes, e.g. meetings/Meeting - 2_30 PM Today.md), then optionally two spaces and a quoted heading, then optionally two spaces and a list of #tags. COPY paths verbatim from the listing into action.path / action.targetPath — never reconstruct them from parts, never strip the .md, never split on dashes.

OPEN FILE: When an "Open file" block is in the runtime context, that is the note the user currently has open in their editor. Deictic references in the user's message — "this", "this note", "this document", "the doc I'm in", "rewrite this", "my open file" — refer to this file unless they obviously name something else. To modify it in place, propose ONE \`edit_note\` action with \`path\` set to the open file's path verbatim and \`content\` set to the COMPLETE rewritten body (edit_note overwrites — partial content erases the rest). Use \`append_note\` to add to the end without rewriting. The user has a "Restore original" button after every edit, so prefer a real edit over a tentative diff in prose. If the open file body shows a "[truncated]" marker, the actual file is longer than what you can see — refuse to overwrite (it would erase the missing tail) and propose append_note or a narrower edit instead.

PRESERVE FRONTMATTER ON EDIT: When proposing edit_note against a file whose body starts with a YAML frontmatter block (\`---\\n...\\n---\`), copy that frontmatter verbatim into the new content unless the user explicitly asks to change it. Dropping frontmatter silently loses tags, aliases, and other vault metadata.

ORGANIZING (this is the most-skipped rule — don't skip it):
When the user asks to organize / clean up / reorganize / sort / tidy / shuffle / consolidate / move / relocate / flatten — or says they don't want files in some folder — you MUST populate "actions" with concrete move_note operations. Do NOT respond with prose like "your structure is fine", "no moves needed", or "I'd suggest manually doing X". The user has an "Execute all" button and a per-action "Restore" button — they want concrete options to accept or decline, not a deliberation. If the layout genuinely already looks tight, propose at least one alternative grouping (e.g. flatten temp/<topic>/* into <topic>/, or split a catch-all folder by tag) so there's something on the table.

Use vault-listing paths verbatim. "Conservative" means don't rename files and don't change content — it does NOT mean "propose nothing". Put the rationale in the prose body so the user can review before clicking Execute.`;

/**
 * Compact protocol reminder injected on follow-up turns. Glean's chat
 * agent only sees the full bootstrap on the first message of a session;
 * after that, attention to the original system prompt fades and the
 * model often drops the obsidian_metadata block entirely (or returns
 * empty actions even for clear vault-operation requests). The reminder
 * is small enough to ship every turn cheaply but imperative enough to
 * keep the action contract front-of-mind.
 *
 * Kept in code (not just bootstrap) so users who customize their
 * bootstrap don't lose it — it always ships.
 */
export function buildProtocolReminder(): string {
  return (
    `(gtfo protocol reminder — keep this contract on EVERY reply:\n` +
    `1. Reply in natural Markdown.\n` +
    `2. End with ONE fenced \`\`\`obsidian_metadata\`\`\` JSON block ` +
    `with optional title, tags, summary, and actions[].\n` +
    `3. Action shapes: create_note, edit_note, append_note, ` +
    `insert_at_cursor, move_note, link_notes, run_command. ` +
    `Use vault-listing paths verbatim.\n` +
    `4. ORGANIZE / CLEAN UP / SHUFFLE / MOVE / "I don't want X under Y" ` +
    `requests MUST emit move_note actions — don't just describe what ` +
    `you'd do. The user has Execute All and Restore buttons; your job ` +
    `is to propose, not deliberate.\n` +
    `5. REWRITE / REWORD / "write this like X" against the Open file ` +
    `MUST emit one edit_note with the open file's path verbatim and ` +
    `the COMPLETE rewritten body.\n` +
    `6. Empty actions is fine ONLY for pure questions / lookups / ` +
    `summaries — never for vault-operation requests.)`
  );
}

const METADATA_BLOCK_RE = /```obsidian_metadata\s*\n([\s\S]*?)\n```/i;

/**
 * Find the `obsidian_metadata` fenced code block in the markdown body
 * and parse its JSON payload as an ObsidianMetadata object. Returns
 * an empty object when no block is present, when the JSON is malformed,
 * or when the payload isn't an object.
 *
 * Tolerates a few common drift modes:
 *   - `tags` as a single string → split on commas/whitespace
 *   - `tags` with leading `#` → stripped
 *   - `actions` as a single object → wrapped in array
 *   - unknown fields → ignored (forward-compat)
 */
export function extractObsidianMetadata(body: string): ObsidianMetadata {
  if (!body) return {};
  const m = body.match(METADATA_BLOCK_RE);
  if (!m) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const obj = parsed as Record<string, unknown>;
  const out: ObsidianMetadata = {};

  if (typeof obj.title === "string" && obj.title.trim()) {
    out.title = obj.title.trim();
  }
  if (typeof obj.summary === "string" && obj.summary.trim()) {
    out.summary = obj.summary.trim();
  }
  if (Array.isArray(obj.tags)) {
    const tags = obj.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.replace(/^#/, "").trim())
      .filter((t) => t.length > 0);
    if (tags.length > 0) out.tags = tags;
  } else if (typeof obj.tags === "string") {
    const tags = obj.tags
      .split(/[\s,]+/)
      .map((t) => t.replace(/^#/, "").trim())
      .filter((t) => t.length > 0);
    if (tags.length > 0) out.tags = tags;
  }
  if (Array.isArray(obj.actions)) {
    const actions = obj.actions.filter(
      (a): a is LlmAction =>
        typeof a === "object" &&
        a !== null &&
        typeof (a as { type?: unknown }).type === "string",
    );
    if (actions.length > 0) out.actions = actions;
  } else if (
    obj.actions &&
    typeof obj.actions === "object" &&
    typeof (obj.actions as { type?: unknown }).type === "string"
  ) {
    out.actions = [obj.actions as LlmAction];
  }
  return out;
}

/**
 * Remove the obsidian_metadata fenced block (and any trailing whitespace
 * left behind) so the user doesn't see the raw JSON in the rendered
 * markdown. Returns the body unchanged if no block is present.
 */
export function stripMetadataBlock(body: string): string {
  return body.replace(METADATA_BLOCK_RE, "").trimEnd();
}

/**
 * Build a short "runtime context" block that gets prepended to every
 * outgoing chat message. The LLM doesn't know today's date, the local
 * time, or the vault name on its own — without this, it tends to emit
 * Templater-style placeholders like `{{date:YYYY-MM-DD}}` when asked
 * to create time-sensitive notes, and those placeholders get written
 * to disk verbatim (we don't expand templates).
 *
 * Kept deliberately small and parenthetical so the LLM treats it as
 * meta context, not as part of the user's turn.
 */
export function buildRuntimeContext(
  opts: { vaultName?: string; now?: Date } = {},
): string {
  const now = opts.now ?? new Date();
  const date = formatDate(now, "YYYY-MM-DD");
  const day = formatDate(now, "dddd");
  const time = formatDate(now, "HH:mm");
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    // some environments don't expose this -- ignore
  }
  const parts = [
    `today is ${date} (${day})`,
    `local time ${time}${tz ? ` ${tz}` : ""}`,
  ];
  if (opts.vaultName) parts.push(`vault "${opts.vaultName}"`);
  return (
    `(gtfo runtime: ${parts.join("; ")}. ` +
    `When a note needs a date or time, write the actual value -- ` +
    `never emit template placeholders like {{date}} or {{date:YYYY-MM-DD}}.)`
  );
}

/**
 * Format a vault listing as a flat list of full paths for LLM context.
 * See the original docstring (unchanged behavior) — the LLM uses these
 * paths verbatim in its action.path / action.targetPath fields.
 */
export function buildVaultListing(
  entries: VaultEntry[],
  opts: { maxChars?: number; vaultName?: string } = {},
): string {
  if (entries.length === 0) return "";
  const max = opts.maxChars ?? 6000;

  const header =
    `Vault listing${opts.vaultName ? ` (${opts.vaultName})` : ""} — ` +
    `${entries.length} note${entries.length === 1 ? "" : "s"}. ` +
    `Use these vault-relative paths verbatim (including the .md extension) ` +
    `when proposing edit_note / move_note / append_note / link_notes actions:`;
  const lines: string[] = [header];

  for (const e of entries) {
    let line = `- ${e.path}`;
    if (
      e.h1 &&
      e.h1.trim() &&
      e.h1.trim().toLowerCase() !== e.name.toLowerCase()
    ) {
      line += `  "${e.h1.trim().replace(/"/g, '\\"')}"`;
    }
    if (e.tags.length > 0) {
      line += `  ${e.tags.map((t) => `#${t}`).join(" ")}`;
    }
    lines.push(line);
  }

  const full = lines.join("\n");
  if (full.length <= max) return full;

  const byFolder = new Map<string, number>();
  for (const e of entries) {
    const f = e.folder || "(root)";
    byFolder.set(f, (byFolder.get(f) ?? 0) + 1);
  }
  const folderLines = [...byFolder.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([f, n]) => `- ${f}: ${n} note${n === 1 ? "" : "s"}`);
  const truncatedHeader =
    `Vault listing${opts.vaultName ? ` (${opts.vaultName})` : ""} — ` +
    `${entries.length} notes (full listing was ${Math.round(full.length / 1024)}KB; ` +
    `showing folder summary only — ask the user to narrow the scope or use Ctrl+Enter search to find specific files):`;
  return [truncatedHeader, ...folderLines].join("\n");
}

/**
 * Format the file the user is currently editing as an "Open file" block
 * for the runtime context. Returns "" when no file is supplied.
 *
 * The body is fenced as ```markdown so the LLM treats it as the file's
 * literal contents rather than as instructions to follow. Long files
 * are truncated at `maxChars` and a "[truncated …]" marker is appended
 * — the bootstrap tells the LLM not to overwrite a truncated file
 * (an edit_note with the visible portion would erase the missing tail).
 */
export function buildOpenFileContext(
  file: { path: string; content: string } | null,
  opts: { maxChars?: number } = {},
): string {
  if (!file) return "";
  const max = opts.maxChars ?? 12000;
  const total = file.content.length;
  let body = file.content;
  let truncated = false;
  if (total > max) {
    body = body.slice(0, max);
    truncated = true;
  }
  const header =
    `Open file (${file.path}) — the note the user currently has open ` +
    `in their editor. Deictic references like "this" or "this document" ` +
    `mean this file. Use \`edit_note\` with this exact path to overwrite ` +
    `it; the user has a "Restore original" button after every edit.`;
  const meta = truncated
    ? `[truncated to ${max} of ${total} chars — DO NOT propose edit_note ` +
      `that would erase the missing tail; use append_note or a narrower edit]`
    : `[${total} chars]`;
  return `${header}\n${meta}\n\n\`\`\`markdown\n${body}\n\`\`\``;
}

/**
 * Minimal moment.js-compatible date formatter. Supports the tokens the
 * LLM is most likely to emit: YYYY, YY, MMMM, MMM, MM, M, DD, D, dddd,
 * ddd, HH, H, mm, m, ss, s. Unknown tokens pass through unchanged.
 */
export function formatDate(d: Date, format: string): string {
  return format.replace(
    /YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|m|ss|s/g,
    (token) => {
      switch (token) {
        case "YYYY":
          return String(d.getFullYear());
        case "YY":
          return String(d.getFullYear()).slice(-2);
        case "MMMM":
          return d.toLocaleString("en-US", { month: "long" });
        case "MMM":
          return d.toLocaleString("en-US", { month: "short" });
        case "MM":
          return String(d.getMonth() + 1).padStart(2, "0");
        case "M":
          return String(d.getMonth() + 1);
        case "DD":
          return String(d.getDate()).padStart(2, "0");
        case "D":
          return String(d.getDate());
        case "dddd":
          return d.toLocaleString("en-US", { weekday: "long" });
        case "ddd":
          return d.toLocaleString("en-US", { weekday: "short" });
        case "HH":
          return String(d.getHours()).padStart(2, "0");
        case "H":
          return String(d.getHours());
        case "mm":
          return String(d.getMinutes()).padStart(2, "0");
        case "m":
          return String(d.getMinutes());
        case "ss":
          return String(d.getSeconds()).padStart(2, "0");
        case "s":
          return String(d.getSeconds());
        default:
          return token;
      }
    },
  );
}

/**
 * Expand the common Obsidian/Templater-style placeholders the LLM tends
 * to emit in note content, as a defensive fallback for when the runtime
 * context in the bootstrap wasn't enough to stop it.
 *
 * Handles: {{date}}, {{date:FORMAT}}, {{time}}, {{time:FORMAT}}, {{title}}.
 * Other `{{...}}` expressions are left untouched so they stay visible and
 * inspectable rather than being silently dropped.
 */
export function expandTemplatePlaceholders(
  text: string,
  ctx: { title?: string; now?: Date } = {},
): string {
  if (!text) return text;
  const now = ctx.now ?? new Date();
  return text
    .replace(/\{\{\s*date(?:\s*:\s*([^}]+?))?\s*\}\}/g, (_m, fmt) =>
      formatDate(now, (fmt ?? "YYYY-MM-DD").trim()),
    )
    .replace(/\{\{\s*time(?:\s*:\s*([^}]+?))?\s*\}\}/g, (_m, fmt) =>
      formatDate(now, (fmt ?? "HH:mm").trim()),
    )
    .replace(/\{\{\s*title\s*\}\}/g, ctx.title ?? "");
}

/**
 * Derive a note title from a vault path: strip directories and the .md
 * extension. Used to fill `{{title}}` placeholders for create_note etc.
 */
export function titleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

/**
 * The structured response protocol between GTFO and the LLM.
 *
 * The bootstrap text teaches the LLM to respond with this schema.
 * The plugin parses it to render UI and execute actions.
 */

import type { VaultEntry } from "../types";

export interface LlmResponse {
  title: string;
  body: string;
  actions?: LlmAction[];
}

export interface LlmAction {
  type: "create_note" | "edit_note" | "append_note" | "insert_at_cursor" | "move_note" | "link_notes" | "run_command";
  path?: string;
  content?: string;
  targetPath?: string;
  command?: string;
}

export const DEFAULT_BOOTSTRAP = `You are running inside an Obsidian plugin called GTFO (Glean Tab For Obsidian). Your responses are parsed by the plugin and rendered in Obsidian.

ALL responses MUST be a JSON object with this exact schema (no text outside the JSON):

{
  "llmresponse": {
    "title": "A short title for this response (5-10 words)",
    "body": "The full response in Markdown format.",
    "actions": []
  }
}

The "body" field uses Markdown: headings, lists, links, code blocks, callouts, etc.

ACTIONS: The "actions" array tells the plugin to perform vault operations. Include actions when the user asks to write, create, save, edit, or move notes.

Trigger phrases that MUST produce a create_note action:
- "write me a note about..."
- "create a note..."
- "save this as a note..."
- "make a note on..."

When triggered, include:
{"type": "create_note", "path": "notes/descriptive-name.md", "content": "full markdown content of the note"}

The "content" in the action should be the complete, standalone note content (with frontmatter if appropriate), NOT a reference to the body. The "body" should be a brief summary of what was created.

All available action types:
- {"type": "create_note", "path": "folder/name.md", "content": "full markdown"}
- {"type": "edit_note", "path": "existing.md", "content": "new full content"}
- {"type": "append_note", "path": "existing.md", "content": "content to append"}
- {"type": "insert_at_cursor", "content": "text to insert at cursor"}
- {"type": "move_note", "path": "old/path.md", "targetPath": "new/path.md"}
- {"type": "link_notes", "path": "source.md", "targetPath": "target.md"}
- {"type": "run_command", "command": "shell command to execute"}

When a "Vault listing" block is present in the runtime context, treat it as the authoritative inventory of the user's vault. Each line is: a leading "- ", then the full vault-relative path (which includes the .md extension and may contain spaces and dashes, e.g. meetings/Meeting - 2_30 PM Today.md), then optionally two spaces and a quoted heading, then optionally two spaces and a list of #tags. COPY paths verbatim from the listing into action.path / action.targetPath — never reconstruct them from parts, never strip the .md, never split on dashes.

ORGANIZING: When the user asks to organize, clean up, reorganize, or sort their vault, read the vault listing and propose a sequence of move_note actions in a single response. The user has an "Execute all" button to run them as a batch, so you can propose many at once. Group by name prefix, tags, or obvious topic. Keep proposals conservative — don't rename files, don't change content, only move. Put the rationale in the body so the user can review before executing.

For pure Q&A with no vault operation requested, omit the actions array.
ALWAYS respond with valid JSON only.`;

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
 *
 * The format is deliberately flat (one full vault-relative path per line,
 * `.md` included) instead of a tree. Tree formatting is more compact but
 * forces the LLM to reconstruct paths from indented filenames + parent
 * folder labels, which is fragile when filenames contain dashes or other
 * "structural-looking" characters (e.g. "Meeting - 2_30 PM Today.md").
 *
 * Per-line format:
 *   - {path}[  "{h1}"][  #tag1 #tag2]
 *
 * Two-space separators after the path act as field delimiters; the `.md`
 * extension acts as a visual terminator for the path. Quotes around the
 * H1 keep it unambiguous when it contains spaces, dashes, or punctuation.
 *
 * The result is capped at `maxChars` — when the full listing would
 * exceed the cap, we drop to a folder-only summary with counts so the
 * LLM can still reason about structure without blowing the context window.
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
    // Show the H1 only when it adds signal beyond the filename
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

  // Fall back to a folder-only summary so the LLM can still reason about
  // structure without blowing the context budget.
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
    `showing folder summary only — ask the user to narrow the scope or use Opt+Enter search to find specific files):`;
  return [truncatedHeader, ...folderLines].join("\n");
}

/**
 * Minimal moment.js-compatible date formatter. Supports the tokens the
 * LLM is most likely to emit: YYYY, YY, MMMM, MMM, MM, M, DD, D, dddd,
 * ddd, HH, H, mm, m, ss, s. Unknown tokens pass through unchanged.
 *
 * The regex alternation is ordered longest-first so e.g. `MMMM` wins
 * over `MM` and `M`.
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

/**
 * Parse an LLM response string into a structured LlmResponse.
 * Handles both raw JSON and JSON embedded in markdown code blocks.
 */
export function parseLlmResponse(raw: string): LlmResponse | null {
  const trimmed = raw.trim();

  // Try direct parse
  const direct = tryParse(trimmed);
  if (direct) return direct;

  // Try extracting from markdown code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    const parsed = tryParse(codeBlockMatch[1].trim());
    if (parsed) return parsed;
  }

  // Try finding JSON object in the string
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const parsed = tryParse(trimmed.substring(jsonStart, jsonEnd + 1));
    if (parsed) return parsed;
  }

  // Fallback: treat entire response as unstructured
  return {
    title: "Response",
    body: raw,
  };
}

function tryParse(text: string): LlmResponse | null {
  try {
    const obj = JSON.parse(text);
    if (obj.llmresponse) {
      return {
        title: obj.llmresponse.title || "Response",
        body: obj.llmresponse.body || "",
        actions: obj.llmresponse.actions || undefined,
      };
    }
    if (obj.title && obj.body) {
      return {
        title: obj.title,
        body: obj.body,
        actions: obj.actions || undefined,
      };
    }
  } catch {
    // not valid JSON
  }
  return null;
}

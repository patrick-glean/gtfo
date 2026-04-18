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

Trigger phrases that MUST populate "actions" with a create_note:
- "write me a note about..."
- "create a note..."
- "save this as a note..."
- "make a note on..."

The action's "content" field should be complete standalone note content (with frontmatter if appropriate), not a reference to your prose. The fenced block is for the plugin only and is stripped from the message before rendering — don't repeat its content in your prose.

VAULT LISTING: When a "Vault listing" block is in the runtime context, treat it as the inventory of the user's vault. Each line is: a leading "- ", then the full vault-relative path (which includes the .md extension and may contain spaces and dashes, e.g. meetings/Meeting - 2_30 PM Today.md), then optionally two spaces and a quoted heading, then optionally two spaces and a list of #tags. COPY paths verbatim from the listing into action.path / action.targetPath — never reconstruct them from parts, never strip the .md, never split on dashes.

ORGANIZING: When the user asks to organize, clean up, reorganize, or sort their vault, propose a sequence of move_note actions in one obsidian_metadata block — the user has an "Execute all" button to apply them as a batch. Group by name prefix, tags, or topic. Keep proposals conservative — don't rename files, don't change content, only move. Put the rationale in the prose body so the user can review before executing.`;

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

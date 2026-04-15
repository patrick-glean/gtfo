/**
 * The structured response protocol between GTFO and the LLM.
 *
 * The bootstrap text teaches the LLM to respond with this schema.
 * The plugin parses it to render UI and execute actions.
 */

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

For pure Q&A with no vault operation requested, omit the actions array.
ALWAYS respond with valid JSON only.`;

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

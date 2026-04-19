import type { VaultTools } from "../tools/vault-tools";
import type { ObsidianMetadata } from "../types";

export interface DebugRequest {
  mode: "chat" | "search" | "tool";
  tool?: string;
  prompt?: string;
  args?: Record<string, unknown>;
  chatId?: string;
}

export interface DebugResult {
  reqMs: number;
  response: unknown;
  extractedContent?: string;
  /**
   * Structured fields parsed out of the assistant's `obsidian_metadata`
   * fenced block (title, tags, summary, actions). Undefined when no
   * block was present.
   */
  metadata?: ObsidianMetadata;
  error?: string;
  errorKind?: "cancelled" | "timeout" | "other";
}

export class DebugLogger {
  constructor(private vaultTools: VaultTools) {}

  async log(
    request: DebugRequest,
    result: DebugResult,
    folder = "gtfo-debug",
  ): Promise<string | null> {
    try {
      const now = new Date();
      const stamp = now
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .split("Z")[0];

      const slug = this.slugify(
        request.prompt || request.tool || request.mode,
      );
      const cleanFolder = folder.replace(/\/$/, "") || "gtfo-debug";
      const path = `${cleanFolder}/${stamp}__${request.mode}__${slug}.md`;

      const content = this.formatNote(request, result, now);
      await this.vaultTools.createNote(path, content);
      return path;
    } catch (e) {
      console.error("[GTFO] debug log failed:", e);
      return null;
    }
  }

  private formatNote(
    request: DebugRequest,
    result: DebugResult,
    timestamp: Date,
  ): string {
    const lines: string[] = [];

    lines.push("---");
    lines.push("source: gtfo-debug");
    lines.push(`mode: ${request.mode}`);
    if (request.tool) lines.push(`tool: ${request.tool}`);
    lines.push(`timestamp: ${timestamp.toISOString()}`);
    lines.push(`req_ms: ${result.reqMs}`);
    if (result.error) lines.push(`error: ${JSON.stringify(result.error)}`);
    lines.push("---");
    lines.push("");

    lines.push(`# ${request.mode === "chat" ? "Chat" : request.mode === "search" ? "Search" : "Tool call"} — ${request.prompt?.substring(0, 80) || request.tool || ""}`);
    lines.push("");

    // Request section
    lines.push("## Request");
    lines.push("");
    if (request.prompt) {
      lines.push("**Prompt:**");
      lines.push("```");
      lines.push(request.prompt);
      lines.push("```");
      lines.push("");
    }
    if (request.chatId) {
      lines.push(`**Chat ID:** \`${request.chatId}\``);
      lines.push("");
    }
    if (request.args) {
      // Pull `context` out for separate, readable rendering — JSON-stringifying
      // a 6KB bootstrap with embedded newlines is unreadable. Other args
      // still go through the JSON dump.
      const { context, ...restArgs } = request.args as Record<string, unknown>;
      if (Object.keys(restArgs).length > 0) {
        lines.push("**Arguments:**");
        lines.push("```json");
        lines.push(JSON.stringify(restArgs, null, 2));
        lines.push("```");
        lines.push("");
      }
      if (Array.isArray(context) && context.length > 0) {
        lines.push(`**Context entries (${context.length}):**`);
        lines.push("");
        context.forEach((entry, i) => {
          const label = previewLabel(entry);
          lines.push(`<details><summary>[${i}] ${label}</summary>`);
          lines.push("");
          lines.push("```");
          lines.push(typeof entry === "string" ? entry : String(entry));
          lines.push("```");
          lines.push("");
          lines.push("</details>");
          lines.push("");
        });
      }
    }

    // Timing
    lines.push("## Timing");
    lines.push("");
    lines.push(`- Total: **${result.reqMs}ms**`);
    lines.push("");

    // Raw response
    lines.push("## Raw MCP Response");
    lines.push("");
    lines.push("```json");
    try {
      lines.push(JSON.stringify(result.response, null, 2));
    } catch {
      lines.push(String(result.response));
    }
    lines.push("```");
    lines.push("");

    // Response shape analysis
    lines.push("## Response Shape");
    lines.push("");
    lines.push("```");
    lines.push(this.describeShape(result.response));
    lines.push("```");
    lines.push("");

    // Extracted content
    if (result.extractedContent) {
      lines.push("## Extracted Content");
      lines.push("");
      lines.push("```");
      lines.push(result.extractedContent);
      lines.push("```");
      lines.push("");
    }

    if (result.metadata) {
      lines.push("## Obsidian Metadata");
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(result.metadata, null, 2));
      lines.push("```");
      lines.push("");
    }

    if (result.error) {
      lines.push("## Error");
      lines.push("");
      lines.push("```");
      lines.push(result.error);
      lines.push("```");
    }

    return lines.join("\n");
  }

  /**
   * Produce a structural description of the response for easy visual inspection.
   */
  private describeShape(value: unknown, indent = 0, maxDepth = 6): string {
    const pad = "  ".repeat(indent);
    if (indent >= maxDepth) return `${pad}...`;

    if (value === null) return `${pad}null`;
    if (value === undefined) return `${pad}undefined`;

    const t = typeof value;
    if (t === "string") {
      const s = value as string;
      const preview = s.length > 60 ? s.substring(0, 60) + "..." : s;
      return `${pad}string (${s.length} chars): "${preview.replace(/\n/g, "\\n")}"`;
    }
    if (t === "number" || t === "boolean") return `${pad}${t}: ${value}`;

    if (Array.isArray(value)) {
      if (value.length === 0) return `${pad}[]`;
      const lines: string[] = [`${pad}Array (${value.length} items):`];
      const sampleCount = Math.min(3, value.length);
      for (let i = 0; i < sampleCount; i++) {
        lines.push(`${pad}  [${i}]:`);
        lines.push(this.describeShape(value[i], indent + 2, maxDepth));
      }
      if (value.length > sampleCount) {
        lines.push(`${pad}  ... (${value.length - sampleCount} more)`);
      }
      return lines.join("\n");
    }

    if (t === "object") {
      const keys = Object.keys(value as object);
      if (keys.length === 0) return `${pad}{}`;
      const lines: string[] = [`${pad}Object (keys: ${keys.join(", ")})`];
      for (const key of keys) {
        lines.push(`${pad}  ${key}:`);
        lines.push(
          this.describeShape(
            (value as Record<string, unknown>)[key],
            indent + 2,
            maxDepth,
          ),
        );
      }
      return lines.join("\n");
    }

    return `${pad}${t}`;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .substring(0, 60)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      || "request";
  }
}

/**
 * Build a one-line collapsed-summary label for a context entry — the
 * first non-empty line, capped to ~60 chars, with the entry's char
 * count appended. Lets the debug note's <details> summaries scan as
 * "what is this chunk?" without having to expand every block.
 */
function previewLabel(entry: unknown): string {
  if (typeof entry !== "string") return `(${typeof entry})`;
  const len = entry.length;
  const firstLine =
    entry.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const truncated =
    firstLine.length > 60 ? `${firstLine.substring(0, 57)}…` : firstLine;
  return `${truncated}  (${len} chars)`;
}

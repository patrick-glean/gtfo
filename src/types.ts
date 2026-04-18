export interface GtfoSettings {
  gleanInstanceUrl: string;
  mcpServerUrl: string;
  authMethod: "oauth" | "token";
  apiToken: string;
  executionMode: "autonomous" | "plan-confirm" | "step-by-step";
  bootstrapText: string;
  /**
   * Per-request timeout for MCP chat/search calls, in milliseconds. The
   * SDK default is 60s; Glean chats can easily take longer, so we bump
   * this to 180s by default and expose it as a setting.
   */
  mcpRequestTimeoutMs: number;
  /**
   * If true, an incoming progress notification from the server resets
   * the per-request timeout. Useful when the server is streaming status
   * updates for a long-running chat.
   */
  mcpResetTimeoutOnProgress: boolean;
  terminalShell: string;
  terminalShellArgs: string;
  terminalFontSize: number;
  /**
   * Newline-separated launch presets for the terminal Launch dropdown.
   * Format per line: `Label = command to run`. Lines without `=` use the
   * whole line as both label and command. Lines starting with # are ignored.
   */
  terminalLaunchPresets: string;
  debugMode: boolean;
  debugFolder: string;
  includeVaultListing: boolean;
  vaultListingExcludes: string;
  vaultListingMaxChars: number;
}

export const DEFAULT_SETTINGS: GtfoSettings = {
  gleanInstanceUrl: "",
  mcpServerUrl: "",
  authMethod: "oauth",
  apiToken: "",
  executionMode: "plan-confirm",
  bootstrapText: "",
  mcpRequestTimeoutMs: 180_000,
  mcpResetTimeoutOnProgress: true,
  terminalShell: process.env.SHELL || "/bin/zsh",
  terminalShellArgs: "",
  terminalFontSize: 13,
  terminalLaunchPresets: [
    "Claude Code = claude",
    "Cursor agent = cursor-agent",
    "Codex = codex",
    "Gemini = gemini",
    "Vim (this folder) = vim .",
    "Git status = git status",
    "List files = ls -la",
  ].join("\n"),
  debugMode: false,
  debugFolder: "gtfo-debug",
  includeVaultListing: true,
  vaultListingExcludes: "",
  vaultListingMaxChars: 6000,
};

export interface TerminalLaunchPreset {
  label: string;
  command: string;
}

export interface VaultEntry {
  path: string;
  name: string;
  folder: string;
  tags: string[];
  h1: string | null;
  mtime: number;
}

export interface GleanSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  lastUpdated?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  citations?: Citation[];
  metrics?: ChatMetrics;
  /**
   * Structured metadata the LLM attached to its reply, parsed from the
   * `obsidian_metadata` fenced block. Carries optional title, tags,
   * summary, and proposed vault actions. Stored on the message so we
   * don't re-parse on every re-render.
   */
  metadata?: ObsidianMetadata;
}

/**
 * Structured side-info the LLM attaches to a reply via a fenced
 * `obsidian_metadata` JSON block at the end. All fields optional.
 *
 * Lets us avoid follow-up LLM calls for things like "what should we
 * call this note?" — the model already labelled its own reply.
 */
export interface ObsidianMetadata {
  /** Recommended note title (5-10 words). Used as filename + H1 on save. */
  title?: string;
  /**
   * Recommended tags (without leading `#`). Lower-case, kebab-case
   * preferred. Surfaced as pills under the message and dropped into
   * frontmatter on Save-as-Note.
   */
  tags?: string[];
  /** Short standalone summary (1-2 sentences). */
  summary?: string;
  /** Vault / shell operations to propose. */
  actions?: LlmAction[];
}

/**
 * Vault / shell operations the LLM can propose, carried inside
 * `metadata.actions`. See `extractObsidianMetadata` in src/llm/protocol.ts.
 */
export interface LlmAction {
  type:
    | "create_note"
    | "edit_note"
    | "append_note"
    | "insert_at_cursor"
    | "move_note"
    | "link_notes"
    | "run_command";
  path?: string;
  content?: string;
  targetPath?: string;
  command?: string;
}

export interface ChatMetrics {
  mode: "chat" | "search";
  reqMs: number;
  tokens?: number;
  bytes?: number;
  /**
   * Number of search results returned. Used in place of `tokens` for
   * search-mode messages, since "tokens" doesn't really mean anything
   * for a search response.
   */
  results?: number;
  /** Present only on error messages (cancelled/timeout/other). */
  errorKind?: "cancelled" | "timeout" | "other";
}

export interface Citation {
  title: string;
  url: string;
  /**
   * Where the citation came from — for Glean responses this is the
   * connector name (gmailnative, gdrive, slack, workflows, etc.) and
   * surfaces as a small tag under the link.
   */
  datasource?: string;
  /**
   * True when this document was an inline citation in the LLM response
   * (i.e. it appeared in a `- citation:` block with referenceRanges),
   * not just a search result returned by an intermediate retrieval step.
   * Cited sources sort to the top and get a "cited" badge.
   */
  cited?: boolean;
  /**
   * Direct-quote snippets pulled from `referenceRanges[].snippets[].text`.
   * Only present on cited sources. See:
   * https://developers.glean.com/guides/chat/deep-linked-citations
   */
  snippets?: string[];
}

export interface VaultOperation {
  type: "create" | "edit" | "move" | "delete" | "link";
  path: string;
  content?: string;
  targetPath?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Persisted usage counters shown under Settings → Usage stats. Updated
 * by the plugin on every chat/search round-trip and every action the
 * user executes. The user can reset them whenever they like.
 */
export interface GtfoStats {
  /** Epoch ms of the last reset (or first load). */
  since: number;

  chatRequests: number;
  searchRequests: number;

  /** Summed wall-clock time across all successful requests. */
  totalReqMs: number;
  /** Summed estimated tokens across all successful requests. */
  totalTokens: number;
  /** Summed response bytes across all successful requests. */
  totalBytes: number;

  cancelledRequests: number;
  timedOutRequests: number;
  failedRequests: number;

  notesCreated: number;
  notesEdited: number;
  notesMoved: number;
  notesLinked: number;
  cursorInserts: number;
  commandsRun: number;
}

export const DEFAULT_STATS: GtfoStats = {
  since: Date.now(),
  chatRequests: 0,
  searchRequests: 0,
  totalReqMs: 0,
  totalTokens: 0,
  totalBytes: 0,
  cancelledRequests: 0,
  timedOutRequests: 0,
  failedRequests: 0,
  notesCreated: 0,
  notesEdited: 0,
  notesMoved: 0,
  notesLinked: 0,
  cursorInserts: 0,
  commandsRun: 0,
};

export interface GtfoSettings {
  gleanInstanceUrl: string;
  mcpServerUrl: string;
  authMethod: "oauth" | "token";
  apiToken: string;
  executionMode: "autonomous" | "plan-confirm" | "step-by-step";
  bootstrapText: string;
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
}

export interface ChatMetrics {
  mode: "chat" | "search";
  reqMs: number;
  tokens?: number;
  bytes?: number;
}

export interface Citation {
  title: string;
  url: string;
  snippet?: string;
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

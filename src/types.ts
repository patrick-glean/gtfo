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
  debugMode: boolean;
  debugFolder: string;
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
  debugMode: false,
  debugFolder: "gtfo-debug",
};

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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ObsidianOAuthProvider, type OAuthStorage } from "./oauth-provider";
import type { NodeGateway } from "../gateway";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { DiscoveredTool } from "../types";

export interface MCPConnectionOptions {
  serverUrl: string;
  authMethod: "oauth" | "token";
  apiToken?: string;
  oauthStorage?: OAuthStorage;
  gateway: NodeGateway;
}

export interface MCPProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface MCPCallOptions {
  /** Abort signal. When aborted, the SDK throws an AbortError. */
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. SDK default is 60s. */
  timeout?: number;
  /** Reset the timeout each time a progress notification arrives. */
  resetTimeoutOnProgress?: boolean;
  /**
   * Called on each progress notification from the server. Glean may or
   * may not emit these — when it does, `message` carries a human-readable
   * status string.
   */
  onProgress?: (progress: MCPProgress) => void;
}

/**
 * Inputs for the Glean MCP `chat` tool. `context` maps to the tool's
 * native `context: string[]` field — "Optional previous messages for
 * context. Will be included in order before the current message." We
 * use it to ship the bootstrap, runtime block, vault listing, open
 * file, and protocol reminder as separate entries instead of bolting
 * them onto the front of the user's actual prompt. Keeps `message` to
 * just what the user typed, which makes the conversation easier for
 * Glean to track and easier for us to debug.
 */
export interface ChatArgs {
  message: string;
  chatId?: string;
  context?: string[];
}

export class GleanMCPClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private oauthProvider: ObsidianOAuthProvider | null = null;
  private _connected = false;
  private _lastListToolsRaw: unknown = undefined;

  /**
   * Predicate used to gate outgoing tool calls. When it returns true
   * for a given tool name, `callTool` throws before contacting the
   * server. Lets users turn individual tools off from the settings
   * panel without restarting the plugin.
   */
  isToolDisabled?: (name: string) => boolean;

  get connected(): boolean {
    return this._connected;
  }

  /**
   * The full unprojected MCP `tools/list` response from the most
   * recent `listTools()` call (or undefined if never called). Powers
   * the "View raw" button in Settings → Tools — mirrors what the
   * server actually sent over the wire, including fields we don't
   * surface in `DiscoveredTool` (annotations, output schemas, _meta).
   */
  get lastListToolsRaw(): unknown {
    return this._lastListToolsRaw;
  }

  async connect(options: MCPConnectionOptions): Promise<void> {
    const url = new URL(options.serverUrl);

    const transportOptions: Record<string, unknown> = {
      fetch: options.gateway.asFetch(),
    };

    if (options.authMethod === "oauth" && options.oauthStorage) {
      this.oauthProvider = new ObsidianOAuthProvider(options.oauthStorage);
      transportOptions.authProvider = this.oauthProvider;
    } else if (options.authMethod === "token" && options.apiToken) {
      transportOptions.requestInit = {
        headers: {
          Authorization: `Bearer ${options.apiToken}`,
          "X-Glean-Auth-Type": "TOKEN",
        },
      };
    }

    this.transport = new StreamableHTTPClientTransport(
      url,
      transportOptions as ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
    );

    this.client = new Client({
      name: "gtfo-obsidian",
      version: "0.1.0",
    });

    await this.client.connect(this.transport);
    this._connected = true;
  }

  async finishOAuth(
    authorizationCode: string,
  ): Promise<void> {
    if (!this.transport) {
      throw new Error("Transport not initialized -- call connect() first");
    }
    await this.transport.finishAuth(authorizationCode);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.transport = null;
      this._connected = false;
    }
  }

  async listTools(): Promise<DiscoveredTool[]> {
    this.ensureConnected();
    const result = await this.client!.listTools();
    this._lastListToolsRaw = result;
    return result.tools.map((t) => {
      const raw = t as {
        name: string;
        title?: string;
        description?: string;
        inputSchema?: {
          type?: string;
          properties?: Record<string, unknown>;
          required?: string[];
        };
      };
      return {
        name: raw.name,
        title: raw.title,
        description: raw.description,
        inputSchema: raw.inputSchema
          ? {
              type: "object",
              properties: raw.inputSchema.properties,
              required: raw.inputSchema.required,
            }
          : undefined,
      };
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: MCPCallOptions = {},
  ): Promise<unknown> {
    this.ensureConnected();
    if (this.isToolDisabled?.(name)) {
      throw new Error(
        `Tool "${name}" is disabled. Enable it under Settings → Tools.`,
      );
    }
    const requestOptions: Record<string, unknown> = {};
    if (options.signal) requestOptions.signal = options.signal;
    if (options.timeout !== undefined) requestOptions.timeout = options.timeout;
    if (options.resetTimeoutOnProgress !== undefined) {
      requestOptions.resetTimeoutOnProgress = options.resetTimeoutOnProgress;
    }
    if (options.onProgress) {
      requestOptions.onprogress = options.onProgress;
    }
    const result = await this.client!.callTool(
      { name, arguments: args },
      undefined,
      requestOptions as Parameters<Client["callTool"]>[2],
    );
    return result;
  }

  async search(query: string, options: MCPCallOptions = {}): Promise<unknown> {
    return this.callTool("search", { query }, options);
  }

  async chat(
    args: ChatArgs,
    options: MCPCallOptions = {},
  ): Promise<unknown> {
    const toolArgs: Record<string, unknown> = { message: args.message };
    if (args.chatId) toolArgs.chatId = args.chatId;
    if (args.context && args.context.length > 0) {
      toolArgs.context = args.context;
    }
    return this.callTool("chat", toolArgs, options);
  }

  async readDocument(
    url: string,
    options: MCPCallOptions = {},
  ): Promise<unknown> {
    return this.callTool("read_document", { url }, options);
  }

  async employeeSearch(
    query: string,
    options: MCPCallOptions = {},
  ): Promise<unknown> {
    return this.callTool("employee_search", { query }, options);
  }

  private ensureConnected(): void {
    if (!this.client || !this._connected) {
      throw new Error("MCP client not connected");
    }
  }
}

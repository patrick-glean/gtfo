import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ObsidianOAuthProvider, type OAuthStorage } from "./oauth-provider";
import type { NodeGateway } from "../gateway";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface MCPConnectionOptions {
  serverUrl: string;
  authMethod: "oauth" | "token";
  apiToken?: string;
  oauthStorage?: OAuthStorage;
  gateway: NodeGateway;
}

export class GleanMCPClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private oauthProvider: ObsidianOAuthProvider | null = null;
  private _connected = false;

  get connected(): boolean {
    return this._connected;
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

  async listTools(): Promise<{ name: string; description?: string }[]> {
    this.ensureConnected();
    const result = await this.client!.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    this.ensureConnected();
    const result = await this.client!.callTool({ name, arguments: args });
    return result;
  }

  async search(query: string): Promise<unknown> {
    return this.callTool("search", { query });
  }

  async chat(message: string, chatId?: string): Promise<unknown> {
    const args: Record<string, unknown> = { message };
    if (chatId) args.chatId = chatId;
    return this.callTool("chat", args);
  }

  async readDocument(url: string): Promise<unknown> {
    return this.callTool("read_document", { url });
  }

  async employeeSearch(query: string): Promise<unknown> {
    return this.callTool("employee_search", { query });
  }

  private ensureConnected(): void {
    if (!this.client || !this._connected) {
      throw new Error("MCP client not connected");
    }
  }
}

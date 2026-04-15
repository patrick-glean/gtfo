import { Plugin, Notice } from "obsidian";
import type { OAuthTokens, OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { GtfoSidebarView, VIEW_TYPE_GTFO } from "./views/sidebar-view";
import { GleanSearchModal } from "./modals/search-modal";
import { GleanMCPClient } from "./mcp/client";
import type { OAuthStorage } from "./mcp/oauth-provider";
import { NodeGateway } from "./gateway";
import { TerminalManager } from "./tools/terminal-manager";
import { VaultTools } from "./tools/vault-tools";
import { ToolRegistry } from "./tools/tool-registry";
import { NoteInserter } from "./utils/note-inserter";
import { GtfoSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type GtfoSettings } from "./types";

interface GtfoData {
  settings: GtfoSettings;
  oauthTokens?: OAuthTokens;
  oauthClientInfo?: OAuthClientInformationFull;
  oauthCodeVerifier?: string;
}

export default class GtfoPlugin extends Plugin {
  settings: GtfoSettings = DEFAULT_SETTINGS;
  gateway: NodeGateway = new NodeGateway();
  mcpClient: GleanMCPClient = new GleanMCPClient();
  terminalManager: TerminalManager = new TerminalManager();
  vaultTools!: VaultTools;
  toolRegistry: ToolRegistry = new ToolRegistry();
  noteInserter!: NoteInserter;

  private data: GtfoData = { settings: DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    this.vaultTools = new VaultTools(this.app);
    this.noteInserter = new NoteInserter(this.vaultTools);

    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    const vaultBase = adapter.getBasePath?.() || "";
    if (vaultBase && this.manifest.dir) {
      const pluginAbsDir = require("path").join(vaultBase, this.manifest.dir);
      this.terminalManager.setPluginDir(pluginAbsDir);
    }

    this.registerView(VIEW_TYPE_GTFO, (leaf) => new GtfoSidebarView(leaf, this));

    this.addRibbonIcon("search", "Open GTFO", () => this.activateView());

    this.addCommand({
      id: "open-gtfo-sidebar",
      name: "Open sidebar",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "gtfo-quick-search",
      name: "Quick search Glean",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "g" }],
      callback: () => {
        new GleanSearchModal(this).open();
      },
    });

    this.addCommand({
      id: "gtfo-connect",
      name: "Connect to Glean",
      callback: () => this.connectToGlean(),
    });

    this.registerObsidianProtocolHandler(
      "gtfo/oauth-callback",
      async (params) => {
        const code = params.code;
        if (!code) {
          new Notice("OAuth callback missing authorization code");
          return;
        }

        try {
          await this.mcpClient.finishOAuth(code);
          // Token exchange done -- now reconnect with the stored tokens
          await this.connectToGlean();
        } catch (e) {
          new Notice(`OAuth failed: ${e}`);
        }
      },
    );

    this.addSettingTab(new GtfoSettingTab(this.app, this));

    this.registerVaultTools();

    if (this.settings.mcpServerUrl && this.settings.authMethod === "token" && this.settings.apiToken) {
      try {
        await this.connectToGlean();
      } catch {
        // Silent fail on startup -- user can reconnect manually
      }
    }
  }

  async onunload(): Promise<void> {
    this.terminalManager.dispose();
    await this.mcpClient.disconnect();
  }

  async connectToGlean(): Promise<void> {
    if (!this.settings.mcpServerUrl) {
      new Notice("Set MCP Server URL in GTFO settings first");
      return;
    }

    await this.mcpClient.disconnect();

    const oauthStorage: OAuthStorage = {
      loadTokens: async () => this.data.oauthTokens,
      saveTokens: async (tokens) => {
        this.data.oauthTokens = tokens;
        await this.saveData(this.data);
      },
      loadClientInfo: async () => this.data.oauthClientInfo,
      saveClientInfo: async (info) => {
        this.data.oauthClientInfo = info;
        await this.saveData(this.data);
      },
      loadCodeVerifier: async () => this.data.oauthCodeVerifier,
      saveCodeVerifier: async (verifier) => {
        this.data.oauthCodeVerifier = verifier;
        await this.saveData(this.data);
      },
    };

    try {
      await this.mcpClient.connect({
        serverUrl: this.settings.mcpServerUrl,
        authMethod: this.settings.authMethod,
        apiToken: this.settings.apiToken,
        oauthStorage,
        gateway: this.gateway,
      });
    } catch (e) {
      const errStr = String(e);
      // OAuth redirect is expected to interrupt the initial connection
      if (errStr.includes("Unauthorized") || errStr.includes("auth")) {
        console.log("[GTFO] OAuth redirect initiated, waiting for callback...");
        new Notice("Redirecting to Glean for authentication...");
        return;
      }
      new Notice(`Connection failed: ${e}`);
      throw e;
    }

    try {
      const tools = await this.mcpClient.listTools();
      new Notice(`Connected to Glean (${tools.length} tools available)`);

      // Refresh the sidebar if it's open
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GTFO);
      for (const leaf of leaves) {
        const view = leaf.view as GtfoSidebarView;
        view.onOpen();
      }
    } catch (e) {
      new Notice(`Connected but tool listing failed: ${e}`);
    }
  }

  async disconnect(): Promise<void> {
    await this.mcpClient.disconnect();
    this.data.oauthTokens = undefined;
    await this.saveData(this.data);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_GTFO)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (!rightLeaf) return;
      leaf = rightLeaf;
      await leaf.setViewState({ type: VIEW_TYPE_GTFO, active: true });
    }

    workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
    if (loaded) {
      this.data = { ...this.data, ...loaded };
      this.settings = { ...DEFAULT_SETTINGS, ...this.data.settings };
    }
  }

  async saveSettings(): Promise<void> {
    this.data.settings = this.settings;
    await this.saveData(this.data);
  }

  private registerVaultTools(): void {
    this.toolRegistry.register({
      name: "create_note",
      description: "Create a new note in the vault",
      parameters: { path: { type: "string" }, content: { type: "string" } },
      execute: async (args) => {
        const file = await this.vaultTools.createNote(
          args.path as string,
          args.content as string,
        );
        return { path: file.path };
      },
    });

    this.toolRegistry.register({
      name: "read_note",
      description: "Read the contents of a note",
      parameters: { path: { type: "string" } },
      execute: async (args) => {
        return { content: await this.vaultTools.readNote(args.path as string) };
      },
    });

    this.toolRegistry.register({
      name: "edit_note",
      description: "Replace the contents of a note",
      parameters: { path: { type: "string" }, content: { type: "string" } },
      execute: async (args) => {
        await this.vaultTools.editNote(args.path as string, args.content as string);
        return { success: true };
      },
    });

    this.toolRegistry.register({
      name: "move_note",
      description: "Move or rename a note",
      parameters: { from: { type: "string" }, to: { type: "string" } },
      execute: async (args) => {
        await this.vaultTools.moveNote(args.from as string, args.to as string);
        return { success: true };
      },
    });

    this.toolRegistry.register({
      name: "list_notes",
      description: "List notes in the vault, optionally in a folder",
      parameters: { folder: { type: "string", optional: true } },
      execute: async (args) => {
        return { notes: this.vaultTools.listNotes(args.folder as string | undefined) };
      },
    });

    this.toolRegistry.register({
      name: "insert_at_cursor",
      description: "Insert text at the cursor position in the active note",
      parameters: { content: { type: "string" } },
      execute: async (args) => {
        const inserted = await this.vaultTools.insertAtCursor(args.content as string);
        return { inserted };
      },
    });

    this.toolRegistry.register({
      name: "run_command",
      description: "Execute a shell command and return its output",
      parameters: { command: { type: "string" }, cwd: { type: "string", optional: true } },
      execute: async (args) => {
        return this.gateway.exec(args.command as string, {
          cwd: args.cwd as string | undefined,
        });
      },
    });

    this.toolRegistry.register({
      name: "http_request",
      description: "Make an HTTP request (CORS-free)",
      parameters: {
        url: { type: "string" },
        method: { type: "string", optional: true },
        headers: { type: "object", optional: true },
        body: { type: "string", optional: true },
      },
      execute: async (args) => {
        const resp = await this.gateway.http({
          url: args.url as string,
          method: (args.method as string) || "GET",
          headers: (args.headers as Record<string, string>) || {},
          body: args.body as string | undefined,
        });
        return { status: resp.status, body: await resp.text() };
      },
    });

    this.toolRegistry.register({
      name: "read_file",
      description: "Read a file from the filesystem (outside vault)",
      parameters: { path: { type: "string" } },
      execute: async (args) => {
        return { content: await this.gateway.readFile(args.path as string) };
      },
    });

    this.toolRegistry.register({
      name: "write_file",
      description: "Write a file to the filesystem (outside vault)",
      parameters: { path: { type: "string" }, content: { type: "string" } },
      execute: async (args) => {
        await this.gateway.writeFile(args.path as string, args.content as string);
        return { success: true };
      },
    });
  }
}

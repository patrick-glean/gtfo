import { Plugin, Notice } from "obsidian";
import type { OAuthTokens, OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { GtfoSidebarView, VIEW_TYPE_GTFO } from "./views/sidebar-view";
import { GleanMCPClient } from "./mcp/client";
import type { OAuthStorage } from "./mcp/oauth-provider";
import { NodeGateway } from "./gateway";
import { TerminalManager } from "./tools/terminal-manager";
import { VaultTools } from "./tools/vault-tools";
import { ToolRegistry } from "./tools/tool-registry";
import { NoteInserter } from "./utils/note-inserter";
import { DebugLogger } from "./debug/debug-logger";
import { GtfoSettingTab } from "./settings";
import {
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
  type DiscoveredTool,
  type GtfoSettings,
  type GtfoStats,
} from "./types";

export type ErrorKind = "cancelled" | "timeout" | "other";
export type ActionKind =
  | "noteCreated"
  | "noteEdited"
  | "noteMoved"
  | "noteLinked"
  | "cursorInsert"
  | "commandRun";

interface GtfoData {
  settings: GtfoSettings;
  stats: GtfoStats;
  oauthTokens?: OAuthTokens;
  oauthClientInfo?: OAuthClientInformationFull;
  oauthCodeVerifier?: string;
}

export default class GtfoPlugin extends Plugin {
  settings: GtfoSettings = DEFAULT_SETTINGS;
  stats: GtfoStats = { ...DEFAULT_STATS };
  gateway: NodeGateway = new NodeGateway();
  mcpClient: GleanMCPClient = new GleanMCPClient();
  terminalManager: TerminalManager = new TerminalManager();
  vaultTools!: VaultTools;
  toolRegistry: ToolRegistry = new ToolRegistry();
  noteInserter!: NoteInserter;
  debugLogger!: DebugLogger;

  /**
   * Tools advertised by the connected MCP server. Refreshed on every
   * successful `connectToGlean` and available to the Tools settings
   * panel without a round-trip. The full unprojected response lives on
   * `mcpClient.lastListToolsRaw` for the "View raw" modal.
   */
  discoveredTools: DiscoveredTool[] = [];

  private data: GtfoData = { settings: DEFAULT_SETTINGS, stats: { ...DEFAULT_STATS } };

  async onload(): Promise<void> {
    await this.loadSettings();

    this.vaultTools = new VaultTools(this.app);
    this.noteInserter = new NoteInserter(this.vaultTools);
    this.debugLogger = new DebugLogger(this.vaultTools);

    // Honour the per-tool enabled/disabled setting at the source so
    // any callsite (chat, search, future agent tool-calls) respects it.
    this.mcpClient.isToolDisabled = (name) =>
      this.settings.disabledTools.includes(name);

    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    const vaultBase = adapter.getBasePath?.() || "";
    if (vaultBase && this.manifest.dir) {
      const pluginAbsDir = require("path").join(vaultBase, this.manifest.dir);
      this.terminalManager.setPluginDir(pluginAbsDir);
    }

    this.configureTerminalDebug();

    this.registerView(VIEW_TYPE_GTFO, (leaf) => new GtfoSidebarView(leaf, this));

    this.addRibbonIcon("search", "Open GTFO", () => this.activateView());

    this.addCommand({
      id: "open-gtfo-sidebar",
      name: "Open sidebar",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "gtfo-open-chat",
      name: "Open GTFO chat",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "g" }],
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "gtfo-new-chat",
      name: "New chat",
      callback: () => this.newChat(),
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

    // Auto-reconnect on startup if we have credentials
    const canAutoReconnect =
      this.settings.mcpServerUrl &&
      ((this.settings.authMethod === "token" && this.settings.apiToken) ||
        (this.settings.authMethod === "oauth" && this.data.oauthTokens));

    if (canAutoReconnect) {
      try {
        await this.connectToGlean({ silent: true });
      } catch {
        // Silent fail on startup -- user can reconnect manually
      }
    }
  }

  async onunload(): Promise<void> {
    this.terminalManager.dispose();
    await this.mcpClient.disconnect();
  }

  async connectToGlean(opts?: { silent?: boolean }): Promise<void> {
    const silent = opts?.silent ?? false;

    if (!this.settings.mcpServerUrl) {
      if (!silent) new Notice("Set MCP Server URL in GTFO settings first");
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
        if (!silent) new Notice("Redirecting to Glean for authentication...");
        return;
      }
      if (!silent) new Notice(`Connection failed: ${e}`);
      throw e;
    }

    try {
      const tools = await this.mcpClient.listTools();
      this.discoveredTools = tools;
      if (!silent) new Notice(`Connected to Glean (${tools.length} tools available)`);
      else console.log(`[GTFO] Auto-reconnected to Glean (${tools.length} tools)`);

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

  /**
   * Re-query the server for its current tool list and update
   * `discoveredTools`. Safe to call when not connected — it just
   * clears the list.
   */
  async refreshTools(): Promise<void> {
    if (!this.mcpClient.connected) {
      this.discoveredTools = [];
      return;
    }
    try {
      this.discoveredTools = await this.mcpClient.listTools();
    } catch (e) {
      console.warn("[GTFO] listTools failed:", e);
      this.discoveredTools = [];
    }
  }

  isToolEnabled(name: string): boolean {
    return !this.settings.disabledTools.includes(name);
  }

  async setToolEnabled(name: string, enabled: boolean): Promise<void> {
    const disabled = new Set(this.settings.disabledTools);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    this.settings.disabledTools = [...disabled].sort();
    await this.saveSettings();
  }

  async disconnect(): Promise<void> {
    await this.mcpClient.disconnect();
    this.data.oauthTokens = undefined;
    this.discoveredTools = [];
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

  async newChat(): Promise<void> {
    await this.activateView();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GTFO);
    for (const leaf of leaves) {
      const view = leaf.view as GtfoSidebarView;
      view.newChat?.();
    }
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
    if (loaded) {
      this.data = { ...this.data, ...loaded };
      this.settings = { ...DEFAULT_SETTINGS, ...this.data.settings };
      this.stats = { ...DEFAULT_STATS, ...(this.data.stats ?? {}) };
    }
  }

  async saveSettings(): Promise<void> {
    this.data.settings = this.settings;
    await this.saveData(this.data);
    this.configureTerminalDebug();
  }

  private saveStatsScheduled: number | null = null;

  /**
   * Persist the current stats object. Debounced so a burst of action
   * executions (e.g. "Execute all" running 30 move_note actions)
   * doesn't hammer disk with 30 saves.
   */
  private scheduleStatsSave(): void {
    if (this.saveStatsScheduled !== null) return;
    this.saveStatsScheduled = window.setTimeout(() => {
      this.saveStatsScheduled = null;
      this.data.stats = this.stats;
      void this.saveData(this.data);
    }, 500);
  }

  recordChatRequest(reqMs: number, tokens: number, bytes: number): void {
    this.stats.chatRequests++;
    this.stats.totalReqMs += reqMs;
    this.stats.totalTokens += tokens;
    this.stats.totalBytes += bytes;
    this.scheduleStatsSave();
  }

  recordSearchRequest(reqMs: number, tokens: number, bytes: number): void {
    this.stats.searchRequests++;
    this.stats.totalReqMs += reqMs;
    this.stats.totalTokens += tokens;
    this.stats.totalBytes += bytes;
    this.scheduleStatsSave();
  }

  recordError(kind: ErrorKind): void {
    if (kind === "cancelled") this.stats.cancelledRequests++;
    else if (kind === "timeout") this.stats.timedOutRequests++;
    else this.stats.failedRequests++;
    this.scheduleStatsSave();
  }

  recordAction(kind: ActionKind): void {
    switch (kind) {
      case "noteCreated":
        this.stats.notesCreated++;
        break;
      case "noteEdited":
        this.stats.notesEdited++;
        break;
      case "noteMoved":
        this.stats.notesMoved++;
        break;
      case "noteLinked":
        this.stats.notesLinked++;
        break;
      case "cursorInsert":
        this.stats.cursorInserts++;
        break;
      case "commandRun":
        this.stats.commandsRun++;
        break;
    }
    this.scheduleStatsSave();
  }

  async resetStats(): Promise<void> {
    this.stats = { ...DEFAULT_STATS, since: Date.now() };
    this.data.stats = this.stats;
    await this.saveData(this.data);
  }

  /**
   * Configure the terminal manager's debug logging based on current settings.
   * When debug mode is on, PTY input/output is appended to a debug note.
   */
  configureTerminalDebug(): void {
    if (!this.settings.debugMode) {
      this.terminalManager.setDebug(false);
      return;
    }

    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .split("Z")[0];
    const folder = (this.settings.debugFolder || "gtfo-debug").replace(/\/$/, "");
    const logPath = `${folder}/${stamp}__terminal.md`;

    let pending = "";
    let flushTimer: number | null = null;
    let initialized = false;

    const flush = async () => {
      if (!pending) return;
      const chunk = pending;
      pending = "";
      try {
        if (!initialized) {
          initialized = true;
          const header =
            "---\nsource: gtfo-debug\nmode: terminal\n---\n\n" +
            "# Terminal IO log\n\n```text\n";
          await this.vaultTools.createNote(logPath, header + chunk);
        } else {
          await this.vaultTools.appendToNote(logPath, chunk);
        }
      } catch (e) {
        console.error("[GTFO] terminal debug log flush failed:", e);
      }
    };

    const appender = (line: string) => {
      pending += line;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        void flush();
      }, 250);
    };

    this.terminalManager.setDebug(true, appender, logPath);
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

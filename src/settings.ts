import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type GtfoPlugin from "./main";
import { DEFAULT_BOOTSTRAP } from "./llm/protocol";
import type { GtfoStats } from "./types";

export class GtfoSettingTab extends PluginSettingTab {
  plugin: GtfoPlugin;

  constructor(app: App, plugin: GtfoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Glean Tab For Obsidian" });

    // --- Connection ---
    containerEl.createEl("h3", { text: "Glean Connection" });

    new Setting(containerEl)
      .setName("MCP Server URL")
      .setDesc("Your Glean MCP server endpoint (e.g. https://your-company-be.glean.com/mcp/default)")
      .addText((text) =>
        text
          .setPlaceholder("https://your-company-be.glean.com/mcp/default")
          .setValue(this.plugin.settings.mcpServerUrl)
          .onChange(async (value) => {
            this.plugin.settings.mcpServerUrl = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Request timeout (seconds)")
      .setDesc(
        "Per-request timeout for chat and search calls. Raise this if long Glean conversations hit the timeout. SDK default is 60s; GTFO default is 180s.",
      )
      .addText((text) =>
        text
          .setPlaceholder("180")
          .setValue(
            String(Math.round(this.plugin.settings.mcpRequestTimeoutMs / 1000)),
          )
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            const seconds =
              Number.isFinite(parsed) && parsed > 0 ? parsed : 180;
            this.plugin.settings.mcpRequestTimeoutMs = seconds * 1000;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Reset timeout on progress")
      .setDesc(
        "When the server sends a progress notification, restart the timeout clock. Keep this on so long-running chats that stream status updates don't hard-timeout between messages.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mcpResetTimeoutOnProgress)
          .onChange(async (value) => {
            this.plugin.settings.mcpResetTimeoutOnProgress = value;
            await this.plugin.saveSettings();
          }),
      );

    // --- Authentication ---
    containerEl.createEl("h3", { text: "Authentication" });

    new Setting(containerEl)
      .setName("Auth method")
      .setDesc("OAuth is recommended. API token is simpler for testing.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("oauth", "OAuth 2.1 (PKCE)")
          .addOption("token", "API Token")
          .setValue(this.plugin.settings.authMethod)
          .onChange(async (value: "oauth" | "token") => {
            this.plugin.settings.authMethod = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.authMethod === "oauth") {
      const oauthStatus = this.plugin.mcpClient.connected
        ? "Connected"
        : "Not connected";

      new Setting(containerEl)
        .setName("OAuth Status")
        .setDesc(oauthStatus)
        .addButton((button) => {
          if (this.plugin.mcpClient.connected) {
            button.setButtonText("Disconnect").onClick(async () => {
              await this.plugin.disconnect();
              new Notice("Disconnected from Glean");
              this.display();
            });
          } else {
            button
              .setButtonText("Connect to Glean")
              .setCta()
              .onClick(async () => {
                try {
                  await this.plugin.connectToGlean();
                  new Notice("Connecting to Glean...");
                } catch (e) {
                  new Notice(`Connection failed: ${e}`);
                }
              });
          }
        });
    } else {
      new Setting(containerEl)
        .setName("API Token")
        .setDesc("Glean Client API token with MCP, SEARCH, CHAT scopes")
        .addText((text) =>
          text
            .setPlaceholder("glean_api_...")
            .setValue(this.plugin.settings.apiToken)
            .onChange(async (value) => {
              this.plugin.settings.apiToken = value;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl).addButton((button) =>
        button
          .setButtonText(this.plugin.mcpClient.connected ? "Reconnect" : "Connect")
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.connectToGlean();
              new Notice("Connected to Glean!");
              this.display();
            } catch (e) {
              new Notice(`Connection failed: ${e}`);
            }
          }),
      );
    }

    // --- Agent Behavior ---
    containerEl.createEl("h3", { text: "Agent Behavior" });

    new Setting(containerEl)
      .setName("Bootstrap text")
      .setDesc(
        "System prompt prepended to every chat message. Teaches the LLM to respond with structured JSON for rendering and vault actions.",
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("Enter bootstrap instructions for the LLM...")
          .setValue(this.plugin.settings.bootstrapText || DEFAULT_BOOTSTRAP)
          .onChange(async (value) => {
            this.plugin.settings.bootstrapText = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 12;
        text.inputEl.cols = 50;
        text.inputEl.style.width = "100%";
        text.inputEl.style.fontFamily = "monospace";
        text.inputEl.style.fontSize = "12px";
      });

    new Setting(containerEl).addButton((button) =>
      button.setButtonText("Reset to default").onClick(async () => {
        this.plugin.settings.bootstrapText = DEFAULT_BOOTSTRAP;
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    new Setting(containerEl)
      .setName("Execution mode")
      .setDesc("How the agent handles multi-step operations")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("autonomous", "Autonomous (just do it)")
          .addOption("plan-confirm", "Plan & Confirm (default)")
          .addOption("step-by-step", "Step-by-step (confirm each action)")
          .setValue(this.plugin.settings.executionMode)
          .onChange(async (value: "autonomous" | "plan-confirm" | "step-by-step") => {
            this.plugin.settings.executionMode = value;
            await this.plugin.saveSettings();
          }),
      );

    // --- Vault Context ---
    containerEl.createEl("h3", { text: "Vault Context" });

    new Setting(containerEl)
      .setName("Include vault listing in chat context")
      .setDesc(
        "Send a compact tree of your notes (paths, tags, first headings) with every chat message. Lets the LLM reference real files by name, propose edits, and organize your vault. The debug folder is always excluded.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeVaultListing)
          .onChange(async (value) => {
            this.plugin.settings.includeVaultListing = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Additional folder exclusions")
      .setDesc(
        "Comma-separated folder prefixes to exclude from the listing (e.g. 'archive, journal/private').",
      )
      .addText((text) =>
        text
          .setPlaceholder("archive, private/")
          .setValue(this.plugin.settings.vaultListingExcludes)
          .onChange(async (value) => {
            this.plugin.settings.vaultListingExcludes = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Listing size cap (chars)")
      .setDesc(
        "When the full listing exceeds this, it degrades to a folder summary. Raise if you want more detail, lower if you hit context limits.",
      )
      .addText((text) =>
        text
          .setPlaceholder("6000")
          .setValue(String(this.plugin.settings.vaultListingMaxChars))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            this.plugin.settings.vaultListingMaxChars =
              Number.isFinite(parsed) && parsed > 0 ? parsed : 6000;
            await this.plugin.saveSettings();
          }),
      );

    // --- Terminal ---
    containerEl.createEl("h3", { text: "Terminal" });

    new Setting(containerEl)
      .setName("Shell")
      .setDesc("Shell to use for the embedded terminal")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.terminalShell)
          .onChange(async (value) => {
            this.plugin.settings.terminalShell = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Shell args")
      .setDesc(
        "Arguments passed to the shell. Use '-l' for login shell, '-f' to skip rc files (helpful if your zshrc emits escape sequences).",
      )
      .addText((text) =>
        text
          .setPlaceholder("e.g. -l  or  -f")
          .setValue(this.plugin.settings.terminalShellArgs)
          .onChange(async (value) => {
            this.plugin.settings.terminalShellArgs = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Terminal font size in pixels")
      .addSlider((slider) =>
        slider
          .setLimits(10, 24, 1)
          .setValue(this.plugin.settings.terminalFontSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.terminalFontSize = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Launch presets")
      .setDesc(
        "One per line. Format: 'Label = command'. Lines without '=' use the whole line as both label and command. Lines starting with # are ignored. Used by the Terminal tab's Launch ▾ dropdown.",
      )
      .addTextArea((text) => {
        text
          .setPlaceholder(
            "Claude Code = claude\nVim = vim .\nGit status = git status",
          )
          .setValue(this.plugin.settings.terminalLaunchPresets)
          .onChange(async (value) => {
            this.plugin.settings.terminalLaunchPresets = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 8;
        text.inputEl.style.width = "100%";
        text.inputEl.style.fontFamily = "monospace";
        text.inputEl.style.fontSize = "12px";
      });

    // --- Debug ---
    containerEl.createEl("h3", { text: "Debug" });

    new Setting(containerEl)
      .setName("Debug mode")
      .setDesc(
        "When enabled, every Glean request writes a debug note to your vault with the full request/response, response shape, and timing.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugMode)
          .onChange(async (value) => {
            this.plugin.settings.debugMode = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Debug folder")
      .setDesc("Vault folder where debug notes are written")
      .addText((text) =>
        text
          .setPlaceholder("gtfo-debug")
          .setValue(this.plugin.settings.debugFolder)
          .onChange(async (value) => {
            this.plugin.settings.debugFolder = value || "gtfo-debug";
            await this.plugin.saveSettings();
          }),
      );

    // --- Usage Stats ---
    this.renderStatsSection(containerEl);
  }

  private renderStatsSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Usage Stats" });
    const stats = this.plugin.stats;

    const sinceDate = new Date(stats.since);
    const sinceLabel = sinceDate.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    new Setting(containerEl)
      .setName("Tracking since")
      .setDesc(sinceLabel);

    const block = containerEl.createEl("div", { cls: "gtfo-stats-block" });
    const rows = buildStatRows(stats);
    for (const [label, value] of rows) {
      if (label === "---") {
        block.createEl("div", { cls: "gtfo-stats-divider" });
        continue;
      }
      const row = block.createEl("div", { cls: "gtfo-stats-row" });
      row.createEl("span", { text: label, cls: "gtfo-stats-label" });
      row.createEl("span", { text: value, cls: "gtfo-stats-value" });
    }

    new Setting(containerEl)
      .setName("Reset stats")
      .setDesc("Zero out all counters and set the tracking-since timestamp to now. Cannot be undone.")
      .addButton((button) =>
        button
          .setButtonText("Reset")
          .setWarning()
          .onClick(async () => {
            await this.plugin.resetStats();
            new Notice("Usage stats reset.");
            this.display();
          }),
      );
  }
}

function buildStatRows(stats: GtfoStats): [string, string][] {
  const totalRequests =
    stats.chatRequests + stats.searchRequests;
  const avgReqMs =
    totalRequests > 0 ? stats.totalReqMs / totalRequests : 0;

  return [
    ["Chat requests", formatNum(stats.chatRequests)],
    ["Search requests", formatNum(stats.searchRequests)],
    ["Cancelled", formatNum(stats.cancelledRequests)],
    ["Timed out", formatNum(stats.timedOutRequests)],
    ["Failed (other)", formatNum(stats.failedRequests)],
    ["Avg response time", avgReqMs > 0 ? formatMs(avgReqMs) : "—"],
    ["Total response time", formatMs(stats.totalReqMs)],
    ["Total tokens (est)", formatNum(stats.totalTokens)],
    ["Total bytes", formatBytes(stats.totalBytes)],
    ["---", ""],
    ["Notes created", formatNum(stats.notesCreated)],
    ["Notes edited", formatNum(stats.notesEdited)],
    ["Notes moved", formatNum(stats.notesMoved)],
    ["Notes linked", formatNum(stats.notesLinked)],
    ["Cursor inserts", formatNum(stats.cursorInserts)],
    ["Commands run", formatNum(stats.commandsRun)],
  ];
}

function formatNum(n: number): string {
  return n.toLocaleString();
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms - min * 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

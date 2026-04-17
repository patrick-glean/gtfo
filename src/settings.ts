import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type GtfoPlugin from "./main";
import { DEFAULT_BOOTSTRAP } from "./llm/protocol";

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
  }
}

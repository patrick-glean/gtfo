import { MarkdownRenderer, Notice } from "obsidian";
import type GtfoPlugin from "../../main";
import type { ChatMessage } from "../../types";
import {
  parseLlmResponse,
  DEFAULT_BOOTSTRAP,
  type LlmResponse,
  type LlmAction,
} from "../../llm/protocol";

export class ChatTab {
  private container: HTMLElement;
  private plugin: GtfoPlugin;
  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private messages: ChatMessage[] = [];
  private chatId: string | undefined;

  constructor(container: HTMLElement, plugin: GtfoPlugin) {
    this.container = container;
    this.plugin = plugin;
  }

  render(): void {
    const wrapper = this.container.createDiv({ cls: "gtfo-chat-wrapper" });

    this.messagesEl = wrapper.createDiv({ cls: "gtfo-chat-messages" });

    if (this.messages.length === 0) {
      this.messagesEl.createDiv({
        cls: "gtfo-chat-placeholder",
        text: this.plugin.mcpClient.connected
          ? "Ask Glean anything about your organization..."
          : "Connect to Glean in Settings to start chatting.",
      });
    } else {
      this.renderMessages();
    }

    const inputContainer = wrapper.createDiv({
      cls: "gtfo-chat-input-container",
    });

    this.inputEl = inputContainer.createEl("textarea", {
      placeholder: "Ask Glean...",
      cls: "gtfo-chat-input",
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    const sendBtn = inputContainer.createEl("button", {
      text: "Send",
      cls: "gtfo-chat-send-btn",
    });
    sendBtn.addEventListener("click", () => this.sendMessage());
  }

  private async sendMessage(): Promise<void> {
    const text = this.inputEl?.value?.trim();
    if (!text) return;

    if (!this.plugin.mcpClient.connected) {
      new Notice("Not connected to Glean. Configure in Settings.");
      return;
    }

    const userMsg: ChatMessage = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    this.messages.push(userMsg);

    if (this.inputEl) this.inputEl.value = "";

    this.renderMessages();
    this.scrollToBottom();

    try {
      const bootstrap =
        this.plugin.settings.bootstrapText || DEFAULT_BOOTSTRAP;
      const fullMessage = this.chatId
        ? text
        : `${bootstrap}\n\n---\n\nUser: ${text}`;

      const response = await this.plugin.mcpClient.chat(
        fullMessage,
        this.chatId,
      );
      const rawContent = this.extractRawContent(response);

      // Try to extract chatId for conversation continuity
      this.extractChatId(response);

      const parsed = parseLlmResponse(rawContent);

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: rawContent,
        timestamp: Date.now(),
      };
      this.messages.push(assistantMsg);
      this.renderMessages();
      this.scrollToBottom();

      if (parsed?.actions && parsed.actions.length > 0) {
        this.handleActions(parsed.actions);
      }
    } catch (e) {
      const errorMsg: ChatMessage = {
        role: "assistant",
        content: `Error: ${e}`,
        timestamp: Date.now(),
      };
      this.messages.push(errorMsg);
      this.renderMessages();
    }
  }

  private renderMessages(): void {
    if (!this.messagesEl) return;
    this.messagesEl.empty();

    for (const msg of this.messages) {
      if (msg.role === "user") {
        this.renderUserMessage(msg);
      } else {
        this.renderAssistantMessage(msg);
      }
    }
  }

  private renderUserMessage(msg: ChatMessage): void {
    const msgEl = this.messagesEl!.createDiv({
      cls: "gtfo-chat-message gtfo-chat-message--user",
    });
    msgEl.createDiv({ cls: "gtfo-chat-message-role" }).createSpan({
      text: "You",
    });
    msgEl
      .createDiv({ cls: "gtfo-chat-message-content" })
      .createEl("p", { text: msg.content });
  }

  private renderAssistantMessage(msg: ChatMessage): void {
    const parsed = parseLlmResponse(msg.content);
    const msgEl = this.messagesEl!.createDiv({
      cls: "gtfo-chat-message gtfo-chat-message--assistant",
    });

    const header = msgEl.createDiv({ cls: "gtfo-chat-message-role" });
    header.createSpan({ text: "Glean" });

    if (parsed && parsed.title !== "Response") {
      msgEl.createDiv({
        cls: "gtfo-chat-message-title",
        text: parsed.title,
      });
    }

    const contentEl = msgEl.createDiv({ cls: "gtfo-chat-message-content" });
    const bodyText = parsed ? parsed.body : msg.content;

    MarkdownRenderer.render(
      this.plugin.app,
      bodyText,
      contentEl,
      "",
      this.plugin,
    );

    if (parsed?.actions && parsed.actions.length > 0) {
      const actionsEl = msgEl.createDiv({ cls: "gtfo-chat-actions" });
      actionsEl.createDiv({
        cls: "gtfo-chat-actions-label",
        text: `${parsed.actions.length} action${parsed.actions.length > 1 ? "s" : ""} proposed:`,
      });

      for (const action of parsed.actions) {
        const actionEl = actionsEl.createDiv({ cls: "gtfo-chat-action-item" });
        const desc = this.describeAction(action);
        actionEl.createSpan({ cls: "gtfo-chat-action-desc", text: desc });

        const execBtn = actionEl.createEl("button", {
          text: "Execute",
          cls: "gtfo-result-btn gtfo-action-btn",
        });
        execBtn.addEventListener("click", async () => {
          await this.executeAction(action);
          execBtn.textContent = "Done";
          execBtn.disabled = true;
          execBtn.addClass("gtfo-action-btn--done");
        });
      }
    }

    const actions = msgEl.createDiv({ cls: "gtfo-chat-message-actions" });

    const saveBtn = actions.createEl("button", {
      text: "Save as Note",
      cls: "gtfo-result-btn",
    });
    saveBtn.addEventListener("click", async () => {
      const title = parsed?.title || "Glean Response";
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      const path = `glean/${slug}.md`;
      const frontmatter = `---\nsource: glean\ndate: ${new Date().toISOString().split("T")[0]}\n---\n\n`;
      await this.plugin.vaultTools.createNote(
        path,
        `${frontmatter}# ${title}\n\n${bodyText}`,
      );
      new Notice(`Saved: ${path}`);
    });

    const insertBtn = actions.createEl("button", {
      text: "Insert to Note",
      cls: "gtfo-result-btn",
    });
    insertBtn.addEventListener("click", () => this.insertToNote(bodyText));

    const copyBtn = actions.createEl("button", {
      text: "Copy",
      cls: "gtfo-result-btn",
    });
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(bodyText);
      new Notice("Copied to clipboard");
    });
  }

  private describeAction(action: LlmAction): string {
    switch (action.type) {
      case "create_note":
        return `Create note: ${action.path}`;
      case "edit_note":
        return `Edit note: ${action.path}`;
      case "append_note":
        return `Append to: ${action.path}`;
      case "insert_at_cursor":
        return "Insert at cursor";
      case "move_note":
        return `Move: ${action.path} → ${action.targetPath}`;
      case "link_notes":
        return `Link: ${action.path} → ${action.targetPath}`;
      case "run_command":
        return `Run: ${action.command}`;
      default:
        return `Unknown action: ${action.type}`;
    }
  }

  private async executeAction(action: LlmAction): Promise<void> {
    const { vaultTools, gateway } = this.plugin;

    try {
      switch (action.type) {
        case "create_note":
          if (action.path && action.content) {
            await vaultTools.createNote(action.path, action.content);
            new Notice(`Created: ${action.path}`);
          }
          break;
        case "edit_note":
          if (action.path && action.content) {
            await vaultTools.editNote(action.path, action.content);
            new Notice(`Updated: ${action.path}`);
          }
          break;
        case "append_note":
          if (action.path && action.content) {
            await vaultTools.appendToNote(action.path, action.content);
            new Notice(`Appended to: ${action.path}`);
          }
          break;
        case "insert_at_cursor":
          if (action.content) {
            const ok = await vaultTools.insertAtCursor(action.content);
            new Notice(ok ? "Inserted at cursor" : "No active editor");
          }
          break;
        case "move_note":
          if (action.path && action.targetPath) {
            await vaultTools.moveNote(action.path, action.targetPath);
            new Notice(`Moved to: ${action.targetPath}`);
          }
          break;
        case "link_notes":
          if (action.path && action.targetPath) {
            await vaultTools.linkNotes(action.path, action.targetPath);
            new Notice(`Linked: ${action.path} → ${action.targetPath}`);
          }
          break;
        case "run_command":
          if (action.command) {
            const result = await gateway.exec(action.command);
            new Notice(
              result.exitCode === 0
                ? `Command succeeded`
                : `Command failed (exit ${result.exitCode})`,
            );
          }
          break;
      }
    } catch (e) {
      new Notice(`Action failed: ${e}`);
    }
  }

  private async handleActions(actions: LlmAction[]): Promise<void> {
    const mode = this.plugin.settings.executionMode;

    if (mode === "autonomous") {
      for (const action of actions) {
        await this.executeAction(action);
      }
    }
    // plan-confirm and step-by-step: actions are shown as buttons in the UI
  }

  private async insertToNote(content: string): Promise<void> {
    const markdown = `> [!quote] Glean\n> ${content.split("\n").join("\n> ")}`;
    const inserted = await this.plugin.vaultTools.insertAtCursor(markdown);
    new Notice(inserted ? "Inserted into note" : "No active editor -- open a note first");
  }

  private scrollToBottom(): void {
    if (this.messagesEl) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }

  private extractRawContent(response: unknown): string {
    if (!response || typeof response !== "object") {
      console.log("[GTFO] chat response is not an object:", response);
      return String(response ?? "No response");
    }

    console.log("[GTFO] chat response:", JSON.stringify(response).substring(0, 500));

    const resp = response as Record<string, unknown>;

    // MCP tool response: { content: [{ type: "text", text: "..." }] }
    if (Array.isArray(resp.content)) {
      const textParts = (resp.content as { type: string; text: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.text);
      if (textParts.length > 0) return textParts.join("\n");
    }

    // Glean chat API structure: { messages: [{ fragments: [{ text: "..." }] }] }
    if (Array.isArray(resp.messages)) {
      const msgs = resp.messages as {
        author?: string;
        fragments?: { text?: string }[];
      }[];
      const aiMsg = msgs.find(
        (m) => m.author === "GLEAN_AI" || m.author === "ASSISTANT",
      ) || msgs[msgs.length - 1];
      if (aiMsg?.fragments) {
        const texts = aiMsg.fragments
          .map((f) => f.text)
          .filter((t): t is string => !!t);
        if (texts.length > 0) return texts.join("\n");
      }
    }

    // Direct text field
    if (typeof resp.text === "string") return resp.text;

    // Last resort: stringify
    return JSON.stringify(response, null, 2);
  }

  private extractChatId(response: unknown): void {
    if (!response || typeof response !== "object") return;
    const resp = response as Record<string, unknown>;

    if (typeof resp.chatId === "string") {
      this.chatId = resp.chatId;
      return;
    }

    // May be nested in MCP content
    if (Array.isArray(resp.content)) {
      for (const item of resp.content as { type: string; text: string }[]) {
        if (item.type === "text") {
          try {
            const parsed = JSON.parse(item.text);
            if (parsed.chatId) {
              this.chatId = parsed.chatId;
              return;
            }
          } catch {
            // not JSON
          }
        }
      }
    }
  }
}

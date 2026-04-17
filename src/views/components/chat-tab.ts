import { MarkdownRenderer, Notice } from "obsidian";
import type GtfoPlugin from "../../main";
import type { ChatMessage, ChatMetrics, GleanSearchResult } from "../../types";
import {
  parseLlmResponse,
  DEFAULT_BOOTSTRAP,
  buildRuntimeContext,
  expandTemplatePlaceholders,
  titleFromPath,
  type LlmAction,
} from "../../llm/protocol";

type MessageMode = "chat" | "search";

export class ChatTab {
  private container: HTMLElement;
  private plugin: GtfoPlugin;
  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private hintEl: HTMLElement | null = null;
  private messages: ChatMessage[] = [];
  private chatId: string | undefined;

  constructor(container: HTMLElement, plugin: GtfoPlugin) {
    this.container = container;
    this.plugin = plugin;
  }

  render(): void {
    const wrapper = this.container.createDiv({ cls: "gtfo-chat-wrapper" });

    const toolbar = wrapper.createDiv({ cls: "gtfo-chat-toolbar" });
    const newChatBtn = toolbar.createEl("button", {
      text: "New chat",
      cls: "gtfo-chat-toolbar-btn",
      attr: { title: "Start a fresh conversation (clears history and resets chatId)" },
    });
    newChatBtn.addEventListener("click", () => this.newChat());

    this.messagesEl = wrapper.createDiv({ cls: "gtfo-chat-messages" });
    this.renderMessages();

    const inputContainer = wrapper.createDiv({
      cls: "gtfo-chat-input-container",
    });

    this.inputEl = inputContainer.createEl("textarea", {
      placeholder: "Ask Glean...   (Opt+Enter to search)",
      cls: "gtfo-chat-input",
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const mode: MessageMode = e.altKey ? "search" : "chat";
        this.sendMessage(mode);
      }
    });

    this.inputEl.addEventListener("keyup", () => this.updateHint());
    this.inputEl.addEventListener("focus", () => this.updateHint());

    const sendBtn = inputContainer.createEl("button", {
      text: "Send",
      cls: "gtfo-chat-send-btn",
    });
    sendBtn.addEventListener("click", () => this.sendMessage("chat"));

    this.hintEl = wrapper.createDiv({ cls: "gtfo-chat-hint" });
    this.updateHint();
  }

  private updateHint(): void {
    if (!this.hintEl) return;
    const hasText = !!this.inputEl?.value?.trim();
    if (hasText) {
      this.hintEl.setText("Enter → Chat  ·  Opt+Enter → Search  ·  Shift+Enter → newline");
    } else {
      this.hintEl.setText("");
    }
  }

  onShow(): void {
    this.inputEl?.focus();
    this.scrollToBottom();
  }

  /**
   * Reset the conversation: drop in-memory messages and clear the Glean
   * chatId so the next send starts a fresh conversation (and re-sends the
   * bootstrap text). The Glean-side chat isn't explicitly ended — we just
   * stop referencing it, which is the same behavior as "new chat" in
   * other clients.
   */
  newChat(): void {
    if (this.messages.length === 0 && this.chatId === undefined) {
      this.inputEl?.focus();
      return;
    }
    this.messages = [];
    this.chatId = undefined;
    if (this.inputEl) this.inputEl.value = "";
    this.renderMessages();
    this.updateHint();
    this.inputEl?.focus();
  }

  private async sendMessage(mode: MessageMode): Promise<void> {
    const text = this.inputEl?.value?.trim();
    if (!text) return;

    if (!this.plugin.mcpClient.connected) {
      new Notice("Not connected to Glean. Configure in Settings.");
      return;
    }

    const userMsg: ChatMessage = {
      role: "user",
      content: mode === "search" ? `🔍 ${text}` : text,
      timestamp: Date.now(),
    };
    this.messages.push(userMsg);

    if (this.inputEl) this.inputEl.value = "";
    this.updateHint();

    this.renderMessages();
    this.scrollToBottom();

    // Show a loading indicator
    const loadingMsg: ChatMessage = {
      role: "assistant",
      content: "__LOADING__",
      timestamp: Date.now(),
    };
    this.messages.push(loadingMsg);
    this.renderMessages();
    this.scrollToBottom();

    const t0 = performance.now();
    const debug = this.plugin.settings.debugMode;

    try {
      if (mode === "search") {
        const response = await this.plugin.mcpClient.search(text);
        const reqMs = Math.round(performance.now() - t0);
        const results = this.parseSearchResults(response);
        const content = this.formatSearchResults(text, results);
        const bytes = this.responseBytes(response);

        this.messages.pop();
        this.messages.push({
          role: "assistant",
          content,
          timestamp: Date.now(),
          metrics: {
            mode: "search",
            reqMs,
            tokens: estimateTokens(content),
            bytes,
          },
        });
        this.renderMessages();
        this.scrollToBottom();

        if (debug) {
          this.writeDebugLog(
            { mode: "search", tool: "search", prompt: text, args: { query: text } },
            { reqMs, response, extractedContent: content },
          );
        }
      } else {
        const bootstrap =
          this.plugin.settings.bootstrapText || DEFAULT_BOOTSTRAP;
        // Runtime context (date/time/vault) is injected on EVERY turn,
        // not just the first. The bootstrap gives the LLM its persona
        // and protocol once; the runtime block keeps it anchored to
        // real time on every send, even across day boundaries.
        const runtime = buildRuntimeContext({
          vaultName: this.plugin.app.vault.getName(),
        });
        const fullMessage = this.chatId
          ? `${runtime}\n\n${text}`
          : `${bootstrap}\n\n${runtime}\n\n---\n\nUser: ${text}`;

        const response = await this.plugin.mcpClient.chat(
          fullMessage,
          this.chatId,
        );
        const reqMs = Math.round(performance.now() - t0);
        const rawContent = this.extractRawContent(response);
        this.extractChatId(response);
        const bytes = this.responseBytes(response);

        const parsed = parseLlmResponse(rawContent);

        this.messages.pop();
        this.messages.push({
          role: "assistant",
          content: rawContent,
          timestamp: Date.now(),
          metrics: {
            mode: "chat",
            reqMs,
            tokens: estimateTokens(rawContent),
            bytes,
          },
        });
        this.renderMessages();
        this.scrollToBottom();

        if (parsed?.actions && parsed.actions.length > 0) {
          this.handleActions(parsed.actions);
        }

        if (debug) {
          this.writeDebugLog(
            {
              mode: "chat",
              tool: "chat",
              prompt: text,
              args: { message: fullMessage, chatId: this.chatId },
              chatId: this.chatId,
            },
            {
              reqMs,
              response,
              extractedContent: rawContent,
              parsedLlmResponse: parsed,
            },
          );
        }
      }
    } catch (e) {
      const reqMs = Math.round(performance.now() - t0);
      this.messages.pop(); // remove loading
      this.messages.push({
        role: "assistant",
        content: `Error: ${e}`,
        timestamp: Date.now(),
      });
      this.renderMessages();

      if (debug) {
        this.writeDebugLog(
          { mode, prompt: text },
          { reqMs, response: null, error: String(e) },
        );
      }
    }
  }

  private async writeDebugLog(
    request: Parameters<typeof this.plugin.debugLogger.log>[0],
    result: Parameters<typeof this.plugin.debugLogger.log>[1],
  ): Promise<void> {
    try {
      const path = await this.plugin.debugLogger.log(
        request,
        result,
        this.plugin.settings.debugFolder,
      );
      if (path) {
        new Notice(`Debug log: ${path}`, 2000);
      }
    } catch (e) {
      console.error("[GTFO] debug log failed:", e);
    }
  }

  private responseBytes(response: unknown): number {
    try {
      return new Blob([JSON.stringify(response)]).size;
    } catch {
      return 0;
    }
  }

  private parseSearchResults(response: unknown): GleanSearchResult[] {
    if (!response || typeof response !== "object") return [];
    const resp = response as { content?: { type: string; text: string }[] };
    if (!resp.content) return [];
    const textContent = resp.content.find((c) => c.type === "text");
    if (!textContent) return [];
    try {
      const parsed = JSON.parse(textContent.text);
      const items = Array.isArray(parsed) ? parsed : parsed.results || [];
      return items.map((r: Record<string, string>) => ({
        title: r.title || "Untitled",
        url: r.url || "",
        snippet: r.snippet || r.description || "",
        source: r.source || r.datasource || "",
        lastUpdated: r.lastUpdated || undefined,
      }));
    } catch {
      return [
        {
          title: "Results",
          url: "",
          snippet: textContent.text,
          source: "Glean",
        },
      ];
    }
  }

  private formatSearchResults(
    query: string,
    results: GleanSearchResult[],
  ): string {
    if (results.length === 0) {
      return JSON.stringify({
        llmresponse: {
          title: `No results for "${query}"`,
          body: "Try a different query.",
        },
      });
    }
    const body = results
      .slice(0, 10)
      .map((r) => {
        const parts = [];
        if (r.url) parts.push(`- **[${r.title}](${r.url})**`);
        else parts.push(`- **${r.title}**`);
        if (r.source) parts[0] += ` · *${r.source}*`;
        if (r.snippet) parts.push(`  ${r.snippet}`);
        return parts.join("\n");
      })
      .join("\n\n");
    return JSON.stringify({
      llmresponse: {
        title: `Search: "${query}" (${results.length} result${results.length === 1 ? "" : "s"})`,
        body,
      },
    });
  }

  private renderMessages(): void {
    if (!this.messagesEl) return;
    this.messagesEl.empty();

    if (this.messages.length === 0) {
      this.messagesEl.createDiv({
        cls: "gtfo-chat-placeholder",
        text: this.plugin.mcpClient.connected
          ? "Ask Glean anything about your organization..."
          : "Connect to Glean in Settings to start chatting.",
      });
      return;
    }

    for (const msg of this.messages) {
      if (msg.role === "user") {
        this.renderUserMessage(msg);
      } else if (msg.content === "__LOADING__") {
        this.renderLoading();
      } else {
        this.renderAssistantMessage(msg);
      }
    }
  }

  private renderLoading(): void {
    const msgEl = this.messagesEl!.createDiv({
      cls: "gtfo-chat-message gtfo-chat-message--assistant gtfo-chat-message--loading",
    });
    const dots = msgEl.createDiv({ cls: "gtfo-typing-indicator" });
    for (let i = 0; i < 3; i++) dots.createSpan({ cls: "gtfo-typing-dot" });
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
    const roleLabel = msg.metrics?.mode === "search" ? "Search" : "Glean";
    header.createSpan({ text: roleLabel });
    if (msg.metrics) {
      header.createSpan({
        cls: "gtfo-chat-metrics",
        text: formatMetrics(msg.metrics),
      });
    }

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
      const expandedBody = expandTemplatePlaceholders(bodyText, {
        title: titleFromPath(path),
      });
      await this.plugin.vaultTools.createNote(
        path,
        `${frontmatter}# ${title}\n\n${expandedBody}`,
      );
      new Notice(`Saved: ${path}`);
    });

    const insertBtn = actions.createEl("button", {
      text: "Insert to Note",
      cls: "gtfo-result-btn",
    });
    insertBtn.addEventListener("click", () =>
      this.insertToNote(expandTemplatePlaceholders(bodyText)),
    );

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

    // Defensive fallback: LLMs sometimes emit {{date}} / {{time}} / {{title}}
    // placeholders in note content even with runtime context in the bootstrap.
    // We don't run Obsidian's template engine over LLM output, so anything
    // not expanded here ends up in the file verbatim.
    const title = action.path ? titleFromPath(action.path) : undefined;
    const content =
      action.content !== undefined
        ? expandTemplatePlaceholders(action.content, { title })
        : undefined;

    try {
      switch (action.type) {
        case "create_note":
          if (action.path && content) {
            await vaultTools.createNote(action.path, content);
            new Notice(`Created: ${action.path}`);
          }
          break;
        case "edit_note":
          if (action.path && content) {
            await vaultTools.editNote(action.path, content);
            new Notice(`Updated: ${action.path}`);
          }
          break;
        case "append_note":
          if (action.path && content) {
            await vaultTools.appendToNote(action.path, content);
            new Notice(`Appended to: ${action.path}`);
          }
          break;
        case "insert_at_cursor":
          if (content) {
            const ok = await vaultTools.insertAtCursor(content);
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
      return String(response ?? "No response");
    }

    const resp = response as Record<string, unknown>;

    // Glean chat API structure (structured): { messages: [{ fragments: [{ text: "..." }] }] }
    if (Array.isArray(resp.messages)) {
      const text = extractFromMessages(resp.messages);
      if (text) return text;
    }

    // MCP tool response: { content: [{ type: "text", text: "..." }] }
    // Glean's chat MCP server returns the chat API response serialized as YAML.
    if (Array.isArray(resp.content)) {
      const textParts = (resp.content as { type: string; text: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.text);
      const raw = textParts.join("\n");
      if (raw) {
        // Try extracting the inner llmresponse JSON from the YAML dump
        const extracted = extractLlmJsonFromText(raw);
        if (extracted) return extracted;
        return raw;
      }
    }

    if (typeof resp.text === "string") return resp.text;

    return JSON.stringify(response, null, 2);
  }

  private extractChatId(response: unknown): void {
    if (!response || typeof response !== "object") return;
    const resp = response as Record<string, unknown>;

    if (typeof resp.chatId === "string") {
      this.chatId = resp.chatId;
      return;
    }

    if (Array.isArray(resp.content)) {
      for (const item of resp.content as { type: string; text: string }[]) {
        if (item.type === "text") {
          // Look for chatId in the YAML/JSON text
          const match = item.text.match(/chatId:\s*([a-f0-9]+)/i);
          if (match) {
            this.chatId = match[1];
            return;
          }
        }
      }
    }
  }
}

// ------- Helpers -------

function estimateTokens(text: string): number {
  // Rough heuristic: ~4 chars per token for English
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}

function formatMetrics(m: ChatMetrics): string {
  const parts: string[] = [];
  parts.push(`req ${formatMs(m.reqMs)}`);
  if (m.tokens) parts.push(`${formatNum(m.tokens)} tok`);
  if (m.bytes) parts.push(formatBytes(m.bytes));
  return parts.join(" · ");
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatNum(n: number): string {
  return n.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function extractFromMessages(
  messages: { author?: string; fragments?: { text?: string }[] }[],
): string | null {
  const aiMsg =
    messages.find(
      (m) => m.author === "GLEAN_AI" || m.author === "ASSISTANT",
    ) || messages[messages.length - 1];
  if (!aiMsg?.fragments) return null;
  const texts = aiMsg.fragments.map((f) => f.text).filter((t): t is string => !!t);
  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * Extract the llmresponse JSON from text that may be:
 *  - Raw JSON already
 *  - YAML with an embedded JSON string value
 *  - Markdown with a JSON code block
 */
function extractLlmJsonFromText(text: string): string | null {
  // 1. Maybe it's already raw JSON
  const directJson = findBalancedLlmJson(text);
  if (directJson) return directJson;

  // 2. YAML string value containing escaped JSON (Glean MCP shape):
  //    fragments[N]{text}:\n      "{\n  \"llmresponse\": ...}"
  const yamlPatterns = [
    /fragments\[\d+\]\{text\}:\s*\r?\n?\s*"((?:\\.|[^"\\])*)"/,
    /\btext:\s*\r?\n?\s*"((?:\\.|[^"\\])*)"/,
  ];
  for (const pattern of yamlPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      try {
        const decoded = JSON.parse('"' + match[1] + '"');
        const inner = findBalancedLlmJson(decoded);
        if (inner) return inner;
        if (decoded.includes("llmresponse")) return decoded;
      } catch {
        // fall through
      }
    }
  }

  return null;
}

/**
 * Scan the text for a `{...}` region containing `"llmresponse"` with balanced
 * braces, respecting string escaping.
 */
function findBalancedLlmJson(text: string): string | null {
  const idx = text.indexOf('"llmresponse"');
  if (idx < 0) return null;

  // Walk backwards to the opening `{` before the key
  let start = idx;
  while (start > 0 && text[start] !== "{") start--;
  if (text[start] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.substring(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

import { MarkdownRenderer, Notice } from "obsidian";
import type GtfoPlugin from "../../main";
import type {
  ChatMessage,
  ChatMetrics,
  Citation,
  GleanSearchResult,
  LlmAction,
  ObsidianMetadata,
} from "../../types";
import type { MCPProgress } from "../../mcp/client";
import {
  DEFAULT_BOOTSTRAP,
  buildRuntimeContext,
  buildVaultListing,
  expandTemplatePlaceholders,
  extractObsidianMetadata,
  stripMetadataBlock,
  titleFromPath,
} from "../../llm/protocol";

type MessageMode = "chat" | "search";

/**
 * Rotating "thinking" phrases shown while waiting for the LLM. They
 * cycle every ~2.5s and are overridden the moment the server sends a
 * real progress notification with a `message`. The two-tier list keeps
 * search (typically fast) from flashing through irrelevant chat-only
 * phrases.
 */
const CHAT_PHRASES = [
  "Query in flight…",
  "Thinking through your question…",
  "Consulting the knowledge base…",
  "Recommending best approach…",
  "Pulling relevant context…",
  "Synthesizing response…",
  "Checking the fine print…",
  "Almost there…",
];

const SEARCH_PHRASES = [
  "Searching the index…",
  "Ranking results…",
  "Scoring relevance…",
];

const PHRASE_ROTATION_MS = 2500;

interface PendingRequest {
  controller: AbortController;
  mode: MessageMode;
  startedAt: number;
  phraseIdx: number;
  customStatus: string | null;
  rotateTimer: number | null;
  tickTimer: number | null;
}

export class ChatTab {
  private container: HTMLElement;
  private plugin: GtfoPlugin;
  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private hintEl: HTMLElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private messages: ChatMessage[] = [];
  private chatId: string | undefined;
  private pending: PendingRequest | null = null;

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
      placeholder: "Ask Glean...   (Ctrl+Enter to search)",
      cls: "gtfo-chat-input",
    });

    this.inputEl.addEventListener("keydown", (e) => {
      // Skip during IME composition so we don't fire mid-typing on
      // CJK / accented input.
      if (e.isComposing) return;
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();
      // Ctrl+Enter is the canonical search shortcut (works across
      // platforms, layouts, and IMEs). Cmd+Enter and Opt+Enter are
      // accepted as macOS-friendly alternatives — Opt+Enter is
      // sometimes eaten by the OS/IME before keydown fires.
      const isSearch = e.ctrlKey || e.metaKey || e.altKey;
      this.sendMessage(isSearch ? "search" : "chat");
    });

    this.inputEl.addEventListener("keyup", () => this.updateHint());
    this.inputEl.addEventListener("focus", () => this.updateHint());

    this.sendBtn = inputContainer.createEl("button", {
      text: "Send",
      cls: "gtfo-chat-send-btn",
      attr: { title: "Chat with Glean (Enter). Hold Ctrl to search instead." },
    });
    this.sendBtn.addEventListener("click", () => this.sendMessage("chat"));

    this.hintEl = wrapper.createDiv({ cls: "gtfo-chat-hint" });
    this.updateHint();
  }

  private updateHint(): void {
    if (!this.hintEl) return;
    const hasText = !!this.inputEl?.value?.trim();
    if (hasText) {
      this.hintEl.setText(
        "Enter → Chat  ·  Ctrl+Enter → Search  ·  Shift+Enter → newline",
      );
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
    if (this.pending) {
      new Notice("A request is already in flight — cancel it or wait.");
      return;
    }

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

    this.startPending(mode);

    // Loading message placeholder. The renderer treats __LOADING__
    // specially and draws the live bubble (dots + status + elapsed +
    // cancel button). Updates happen in place on the element refs.
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
    const settings = this.plugin.settings;

    const callOptions = {
      signal: this.pending!.controller.signal,
      timeout: settings.mcpRequestTimeoutMs,
      resetTimeoutOnProgress: settings.mcpResetTimeoutOnProgress,
      onProgress: (p: MCPProgress) => this.handleServerProgress(p),
    };

    try {
      if (mode === "search") {
        const response = await this.plugin.mcpClient.search(text, callOptions);
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
            results: results.length,
            bytes,
          },
        });
        this.renderMessages();
        this.scrollToBottom();
        // Search has no real notion of "tokens" — we record bytes only.
        this.plugin.recordSearchRequest(reqMs, 0, bytes);

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
        const vaultName = this.plugin.app.vault.getName();
        const runtime = buildRuntimeContext({ vaultName });
        const listing = this.buildVaultListingBlock(vaultName);
        const runtimeBlock = listing
          ? `${runtime}\n\n${listing}`
          : runtime;
        const fullMessage = this.chatId
          ? `${runtimeBlock}\n\n${text}`
          : `${bootstrap}\n\n${runtimeBlock}\n\n---\n\nUser: ${text}`;

        const response = await this.plugin.mcpClient.chat(
          fullMessage,
          this.chatId,
          callOptions,
        );
        const reqMs = Math.round(performance.now() - t0);
        const rawContent = this.extractRawContent(response);
        const sources = this.extractSourcesFromResponse(response);
        this.extractChatId(response);
        const bytes = this.responseBytes(response);

        // Pull the obsidian_metadata block out of the markdown body
        // and strip it so the user doesn't see the raw JSON.
        const metadata = extractObsidianMetadata(rawContent);
        const hasMetadata =
          !!metadata.title ||
          !!metadata.summary ||
          (metadata.tags?.length ?? 0) > 0 ||
          (metadata.actions?.length ?? 0) > 0;
        const cleanBody = hasMetadata
          ? stripMetadataBlock(rawContent)
          : rawContent;
        const tokens = estimateTokens(cleanBody);
        const actions = metadata.actions ?? [];

        this.messages.pop();
        this.messages.push({
          role: "assistant",
          content: cleanBody,
          timestamp: Date.now(),
          metrics: {
            mode: "chat",
            reqMs,
            tokens,
            bytes,
          },
          citations: sources.length > 0 ? sources : undefined,
          metadata: hasMetadata ? metadata : undefined,
        });
        this.renderMessages();
        this.scrollToBottom();
        this.plugin.recordChatRequest(reqMs, tokens, bytes);

        if (actions.length > 0) {
          this.handleActions(actions);
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
              extractedContent: cleanBody,
              metadata: hasMetadata ? metadata : undefined,
            },
          );
        }
      }
    } catch (e) {
      const reqMs = Math.round(performance.now() - t0);
      const classified = classifyMcpError(e, settings.mcpRequestTimeoutMs);
      this.messages.pop(); // remove loading
      // Include elapsed time on the error message so the header still
      // reads "Glean  req 12.3s · cancelled" for consistency with
      // successful responses. Tokens/bytes are omitted — we got nothing.
      this.messages.push({
        role: "assistant",
        content: classified.content,
        timestamp: Date.now(),
        metrics: {
          mode,
          reqMs,
          errorKind: classified.kind,
        },
      });
      this.renderMessages();
      this.scrollToBottom();
      this.plugin.recordError(classified.kind);

      if (debug) {
        this.writeDebugLog(
          { mode, prompt: text },
          {
            reqMs,
            response: null,
            error: String(e),
            errorKind: classified.kind,
          },
        );
      }
    } finally {
      this.stopPending();
    }
  }

  /**
   * Set up the pending-request state: abort controller, phrase rotation,
   * and a 1-Hz tick that updates the elapsed-time readout in the
   * loading bubble. Everything gets torn down in stopPending().
   */
  private startPending(mode: MessageMode): void {
    const controller = new AbortController();
    this.pending = {
      controller,
      mode,
      startedAt: performance.now(),
      phraseIdx: 0,
      customStatus: null,
      rotateTimer: null,
      tickTimer: null,
    };

    this.pending.rotateTimer = window.setInterval(() => {
      if (!this.pending || this.pending.customStatus) return;
      this.pending.phraseIdx++;
      this.refreshLoadingBubble();
    }, PHRASE_ROTATION_MS);

    this.pending.tickTimer = window.setInterval(() => {
      if (!this.pending) return;
      this.refreshLoadingBubble();
    }, 1000);

    this.setSendButtonState("pending");
  }

  private stopPending(): void {
    if (this.pending?.rotateTimer) window.clearInterval(this.pending.rotateTimer);
    if (this.pending?.tickTimer) window.clearInterval(this.pending.tickTimer);
    this.pending = null;
    this.setSendButtonState("idle");
  }

  private cancelPending(): void {
    if (!this.pending) return;
    this.pending.controller.abort();
    // stopPending + the catch block in sendMessage will finish cleanup
    // once the awaited request rejects with AbortError.
  }

  private handleServerProgress(p: MCPProgress): void {
    if (!this.pending) return;
    if (p.message) {
      this.pending.customStatus = p.message;
      this.refreshLoadingBubble();
    }
  }

  private currentLoadingStatus(): string {
    if (!this.pending) return "";
    if (this.pending.customStatus) return this.pending.customStatus;
    const phrases =
      this.pending.mode === "chat" ? CHAT_PHRASES : SEARCH_PHRASES;
    return phrases[this.pending.phraseIdx % phrases.length];
  }

  private currentElapsedLabel(): string {
    if (!this.pending) return "";
    const s = (performance.now() - this.pending.startedAt) / 1000;
    if (s < 1) return `${Math.round(s * 1000)}ms`;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s - m * 60);
    return `${m}m ${rem}s`;
  }

  /**
   * Update the live bubble's status text + elapsed readout in place.
   * Safe to call when no bubble is present (no-ops).
   */
  private refreshLoadingBubble(): void {
    if (!this.messagesEl) return;
    const statusEl = this.messagesEl.querySelector(
      ".gtfo-typing-status",
    ) as HTMLElement | null;
    const elapsedEl = this.messagesEl.querySelector(
      ".gtfo-typing-elapsed",
    ) as HTMLElement | null;
    if (statusEl) statusEl.textContent = this.currentLoadingStatus();
    if (elapsedEl) elapsedEl.textContent = this.currentElapsedLabel();
  }

  private setSendButtonState(state: "idle" | "pending"): void {
    if (!this.sendBtn) return;
    if (state === "pending") {
      this.sendBtn.disabled = true;
      this.sendBtn.textContent = "Sending…";
    } else {
      this.sendBtn.disabled = false;
      this.sendBtn.textContent = "Send";
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

  /**
   * Build the vault-listing block that ships alongside the runtime
   * context. Returns "" when the feature is disabled, the vault is
   * empty, or something throws (metadataCache occasionally isn't
   * ready immediately after plugin load — degrade silently).
   */
  private buildVaultListingBlock(vaultName: string): string {
    const s = this.plugin.settings;
    if (!s.includeVaultListing) return "";
    try {
      const userExcludes = (s.vaultListingExcludes ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      // Always exclude the debug folder — those notes are our own
      // output and would balloon the context on every turn.
      const excludes = s.debugFolder
        ? [s.debugFolder, ...userExcludes]
        : userExcludes;
      const entries = this.plugin.vaultTools.listVaultEntries({
        excludePrefixes: excludes,
      });
      return buildVaultListing(entries, {
        maxChars: s.vaultListingMaxChars,
        vaultName,
      });
    } catch (e) {
      console.warn("[GTFO] vault listing failed:", e);
      return "";
    }
  }

  /**
   * Glean's MCP `search` tool returns results as a YAML-formatted text
   * dump under `content[0].text` (not JSON, despite the surrounding MCP
   * envelope). The blob looks like:
   *
   *   documents[N]:
   *     - createTime: "..."
   *       datasource: gdrive
   *       owner:
   *         name: ...
   *       snippets[N]:
   *         - "..."
   *       title: ...
   *       updateTime: "..."
   *       updatedBy:
   *         name: ...
   *       url: "..."
   *
   * We split on top-level document boundaries and pull out the fields
   * the web UI shows: title, url, datasource, updater, last-updated
   * timestamp, and the first non-image snippet (cleaned of HTML).
   */
  private parseSearchResults(response: unknown): GleanSearchResult[] {
    if (!response || typeof response !== "object") return [];
    const resp = response as Record<string, unknown>;
    let raw = "";
    if (Array.isArray(resp.content)) {
      raw = (resp.content as { type: string; text: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    } else if (typeof resp.text === "string") {
      raw = resp.text;
    }
    if (!raw) return [];
    return parseSearchYamlBlob(raw);
  }

  /**
   * Render results in a tight two-line format: bold linked title with
   * a `·`-separated meta line (datasource, relative time, attribution),
   * then the snippet on the next line. A trailing two-space hard break
   * keeps the snippet attached to its title within a single paragraph,
   * so paragraph spacing only kicks in between results — much denser
   * than card-style separators.
   */
  private formatSearchResults(
    query: string,
    results: GleanSearchResult[],
  ): string {
    if (results.length === 0) {
      return `**No results for "${query}".** Try a different query.`;
    }
    const total = results.length;
    const shown = Math.min(total, 10);
    const blocks = results.slice(0, shown).map((r) => {
      const titleText = r.url ? `[${r.title.trim()}](${r.url})` : r.title.trim();
      const meta: string[] = [];
      if (r.source) meta.push(r.source);
      if (r.lastUpdated) {
        const rel = formatRelativeTime(r.lastUpdated);
        if (rel) meta.push(rel);
      }
      // Attribution attaches to the time chip without a middot so it
      // reads naturally ("4d ago by Kiril") instead of ("4d ago · by Kiril").
      let metaStr = meta.join(" · ");
      if (r.owner) metaStr += metaStr ? ` by ${r.owner}` : `by ${r.owner}`;
      const head = metaStr ? `**${titleText}** · ${metaStr}` : `**${titleText}**`;
      if (!r.snippet) return head;
      const snippet = truncateText(r.snippet, 160);
      // Trailing two spaces force a `<br>` so the snippet sits directly
      // under the title in the same paragraph.
      return `${head}  \n${snippet}`;
    });
    const footer = total > shown ? `\n\n…and ${total - shown} more.` : "";
    return blocks.join("\n\n") + footer;
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
    const bubble = msgEl.createDiv({ cls: "gtfo-typing-bubble" });

    const dots = bubble.createDiv({ cls: "gtfo-typing-indicator" });
    for (let i = 0; i < 3; i++) dots.createSpan({ cls: "gtfo-typing-dot" });

    bubble.createSpan({
      cls: "gtfo-typing-status",
      text: this.currentLoadingStatus(),
    });
    bubble.createSpan({
      cls: "gtfo-typing-elapsed",
      text: this.currentElapsedLabel(),
    });

    if (this.pending) {
      const cancelBtn = bubble.createEl("button", {
        text: "Cancel",
        cls: "gtfo-typing-cancel",
        attr: { title: "Stop this request" },
      });
      cancelBtn.addEventListener("click", () => this.cancelPending());
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

    const contentEl = msgEl.createDiv({ cls: "gtfo-chat-message-content" });
    const bodyText = msg.content;

    MarkdownRenderer.render(
      this.plugin.app,
      bodyText,
      contentEl,
      "",
      this.plugin,
    );

    // Tag pills under the body. Visual signal of what the LLM thinks
    // the message is about; same tags drop into frontmatter on save.
    if (msg.metadata?.tags && msg.metadata.tags.length > 0) {
      this.renderTags(msgEl, msg.metadata.tags);
    }

    if (msg.citations && msg.citations.length > 0) {
      this.renderSources(msgEl, msg.citations);
    }

    if (msg.metadata?.actions && msg.metadata.actions.length > 0) {
      this.renderActions(msgEl, msg.metadata.actions);
    }

    const actions = msgEl.createDiv({ cls: "gtfo-chat-message-actions" });

    // Prefer the LLM-suggested title when present — saves us a guess
    // (and the user a follow-up prompt) about what to call the note.
    const suggestedTitle =
      msg.metadata?.title ?? deriveTitleFromMarkdown(bodyText);
    const tags = msg.metadata?.tags ?? [];
    const summary = msg.metadata?.summary;

    const saveBtn = actions.createEl("button", {
      text: "Save as Note",
      cls: "gtfo-result-btn",
      attr: {
        title: buildSaveTooltip(suggestedTitle, tags),
      },
    });
    saveBtn.addEventListener("click", async () => {
      const slug = suggestedTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .substring(0, 80);
      const path = `glean/${slug || "response"}.md`;
      const frontmatter = buildFrontmatter({
        source: "glean",
        date: new Date().toISOString().split("T")[0],
        tags,
        summary,
      });
      const expandedBody = expandTemplatePlaceholders(bodyText, {
        title: titleFromPath(path),
      });
      // Don't double-render the title: if the body already starts with
      // an H1 we use that as-is; otherwise prepend one.
      const startsWithHeading = /^\s*#\s+/.test(bodyText);
      const body = startsWithHeading
        ? expandedBody
        : `# ${suggestedTitle}\n\n${expandedBody}`;
      await this.plugin.vaultTools.createNote(path, `${frontmatter}${body}`);
      this.plugin.recordAction("noteCreated");
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

  /**
   * Render the actions block under an assistant message. When the LLM
   * proposes multiple actions (e.g. an organize-vault batch of move_note),
   * an "Execute all" button runs them sequentially so the user doesn't
   * have to click each row individually.
   */
  /**
   * Render the LLM-suggested tags as small pills under the body. Same
   * tags drop into frontmatter on Save-as-Note.
   */
  private renderTags(msgEl: HTMLElement, tags: string[]): void {
    const wrap = msgEl.createDiv({ cls: "gtfo-chat-message-tags" });
    for (const t of tags) {
      wrap.createSpan({
        cls: "gtfo-chat-tag",
        text: `#${t}`,
        attr: { title: `Suggested tag: ${t}` },
      });
    }
  }

  /**
   * Render the document citations Glean used to answer. Pulled from the
   * `structuredResults` blocks in the YAML wrap. Datasource is shown as
   * a small tag (gdrive, slack, gmailnative, etc.). Internal/relative
   * URLs render as plain text rather than dead links.
   *
   * Wrapped in a native <details> so it's collapsed by default — long
   * agent searches return 15-30 results which would otherwise dominate
   * the chat pane.
   */
  private renderSources(msgEl: HTMLElement, sources: Citation[]): void {
    const wrap = msgEl.createEl("details", { cls: "gtfo-chat-sources" });
    const summary = wrap.createEl("summary", {
      cls: "gtfo-chat-sources-summary",
    });
    summary.createSpan({
      cls: "gtfo-chat-sources-label",
      text: `Sources (${sources.length})`,
    });
    const list = wrap.createEl("ul", { cls: "gtfo-chat-sources-list" });
    for (const s of sources) {
      const li = list.createEl("li", { cls: "gtfo-chat-source-item" });
      const isHttp = /^https?:\/\//i.test(s.url);
      if (isHttp) {
        const a = li.createEl("a", {
          text: s.title,
          cls: "gtfo-chat-source-link",
          attr: { href: s.url, target: "_blank", rel: "noopener" },
        });
        a.title = s.url;
      } else {
        const span = li.createSpan({
          text: s.title,
          cls: "gtfo-chat-source-link gtfo-chat-source-link--plain",
        });
        if (s.url) span.title = s.url;
      }
      if (s.datasource) {
        li.createSpan({
          cls: "gtfo-chat-source-tag",
          text: s.datasource,
        });
      }
    }
  }

  private renderActions(msgEl: HTMLElement, actions: LlmAction[]): void {
    const actionsEl = msgEl.createDiv({ cls: "gtfo-chat-actions" });
    const headerEl = actionsEl.createDiv({ cls: "gtfo-chat-actions-header" });
    headerEl.createDiv({
      cls: "gtfo-chat-actions-label",
      text: `${actions.length} action${actions.length > 1 ? "s" : ""} proposed:`,
    });

    type Row = {
      action: LlmAction;
      btn: HTMLButtonElement;
      done: boolean;
    };
    const rows: Row[] = [];

    const markRow = (row: Row, ok: boolean): void => {
      row.done = true;
      row.btn.disabled = true;
      row.btn.textContent = ok ? "Done" : "Failed";
      row.btn.removeClass("gtfo-action-btn--done");
      row.btn.removeClass("gtfo-action-btn--failed");
      row.btn.addClass(ok ? "gtfo-action-btn--done" : "gtfo-action-btn--failed");
    };

    let execAllBtn: HTMLButtonElement | null = null;
    if (actions.length > 1) {
      execAllBtn = headerEl.createEl("button", {
        text: `Execute all (${actions.length})`,
        cls: "gtfo-result-btn gtfo-action-btn gtfo-chat-actions-execall",
      });
      execAllBtn.addEventListener("click", async () => {
        if (!execAllBtn) return;
        execAllBtn.disabled = true;
        const originalText = execAllBtn.textContent ?? "Execute all";
        let okCount = 0;
        let failCount = 0;
        const pending = rows.filter((r) => !r.done);
        for (let i = 0; i < pending.length; i++) {
          const row = pending[i];
          execAllBtn.textContent = `Running ${i + 1}/${pending.length}...`;
          const ok = await this.executeAction(row.action);
          markRow(row, ok);
          if (ok) okCount++;
          else failCount++;
        }
        execAllBtn.textContent =
          failCount > 0
            ? `Done — ${okCount} ok, ${failCount} failed`
            : `Done (${okCount})`;
        execAllBtn.removeClass("gtfo-action-btn--done");
        execAllBtn.addClass("gtfo-action-btn--done");
        if (!execAllBtn.textContent) execAllBtn.textContent = originalText;
      });
    }

    for (const action of actions) {
      const actionEl = actionsEl.createDiv({ cls: "gtfo-chat-action-item" });
      const desc = this.describeAction(action);
      // Full description on the title attribute so the user can see paths
      // that get truncated by the row's text-overflow: ellipsis.
      actionEl.createSpan({
        cls: "gtfo-chat-action-desc",
        text: desc,
        attr: { title: desc },
      });

      const execBtn = actionEl.createEl("button", {
        text: "Execute",
        cls: "gtfo-result-btn gtfo-action-btn",
      });
      const row: Row = { action, btn: execBtn, done: false };
      rows.push(row);

      execBtn.addEventListener("click", async () => {
        if (row.done) return;
        execBtn.disabled = true;
        execBtn.textContent = "Running...";
        const ok = await this.executeAction(action);
        markRow(row, ok);
      });
    }
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

  private async executeAction(action: LlmAction): Promise<boolean> {
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
            this.plugin.recordAction("noteCreated");
            new Notice(`Created: ${action.path}`);
          }
          break;
        case "edit_note":
          if (action.path && content) {
            await vaultTools.editNote(action.path, content);
            this.plugin.recordAction("noteEdited");
            new Notice(`Updated: ${action.path}`);
          }
          break;
        case "append_note":
          if (action.path && content) {
            await vaultTools.appendToNote(action.path, content);
            this.plugin.recordAction("noteEdited");
            new Notice(`Appended to: ${action.path}`);
          }
          break;
        case "insert_at_cursor":
          if (content) {
            const ok = await vaultTools.insertAtCursor(content);
            new Notice(ok ? "Inserted at cursor" : "No active editor");
            if (!ok) return false;
            this.plugin.recordAction("cursorInsert");
          }
          break;
        case "move_note":
          if (action.path && action.targetPath) {
            await vaultTools.moveNote(action.path, action.targetPath);
            this.plugin.recordAction("noteMoved");
            new Notice(`Moved to: ${action.targetPath}`);
          }
          break;
        case "link_notes":
          if (action.path && action.targetPath) {
            await vaultTools.linkNotes(action.path, action.targetPath);
            this.plugin.recordAction("noteLinked");
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
            if (result.exitCode !== 0) return false;
            this.plugin.recordAction("commandRun");
          }
          break;
      }
      return true;
    } catch (e) {
      new Notice(`Action failed: ${e}`);
      return false;
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
    if (inserted) this.plugin.recordAction("cursorInsert");
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
    // Glean's chat MCP server returns the chat API response serialized
    // as YAML. The natural-markdown reply lives in the CONTENT
    // message's `text` fragments — assemble those and return the
    // concatenated markdown.
    if (Array.isArray(resp.content)) {
      const textParts = (resp.content as { type: string; text: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.text);
      const raw = textParts.join("\n");
      if (raw) {
        const assembled = assembleMarkdownFromContent(raw);
        if (assembled) return assembled;
        return raw;
      }
    }

    if (typeof resp.text === "string") return resp.text;

    return JSON.stringify(response, null, 2);
  }

  /**
   * Pull the YAML blob out of an MCP response and pass it to the
   * source extractor. Returns Citation[] (datasource carries the
   * connector name).
   */
  private extractSourcesFromResponse(response: unknown): Citation[] {
    if (!response || typeof response !== "object") return [];
    const resp = response as Record<string, unknown>;
    let raw = "";
    if (Array.isArray(resp.content)) {
      raw = (resp.content as { type: string; text: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    } else if (typeof resp.text === "string") {
      raw = resp.text;
    }
    if (!raw) return [];
    return extractSourcesFromText(raw).map((s) => ({
      title: s.title,
      url: s.url,
      datasource: s.datasource,
      cited: s.cited,
      snippets: s.snippets,
    }));
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

type McpErrorKind = "cancelled" | "timeout" | "other";

/**
 * Turn whatever the MCP SDK threw into a user-facing Markdown message +
 * a coarse kind label (for debug logs). The SDK throws:
 *   - AbortError when our signal fires (user cancel)
 *   - McpError with code `RequestTimeout` on timeout
 *   - Various other errors for transport/protocol issues
 */
function classifyMcpError(
  err: unknown,
  timeoutMs: number,
): { kind: McpErrorKind; content: string } {
  const name = (err as { name?: string } | null)?.name ?? "";
  const msg = String((err as { message?: string } | null)?.message ?? err ?? "");
  const code = (err as { code?: unknown } | null)?.code;

  if (name === "AbortError" || /abort/i.test(msg)) {
    return {
      kind: "cancelled",
      content: "_Cancelled._",
    };
  }

  const isTimeout =
    code === -32001 || // JSONRPC RequestTimeout
    /\brequesttimeout\b/i.test(msg) ||
    /\btimed?\s*out\b/i.test(msg);
  if (isTimeout) {
    const seconds = Math.round(timeoutMs / 1000);
    return {
      kind: "timeout",
      content:
        `**Request timed out** after ${seconds}s.\n\n` +
        `If Glean chats in your tenant routinely take longer, bump ` +
        `**Settings → Glean Connection → Request timeout** and keep ` +
        `**Reset timeout on progress** on so streamed updates count ` +
        `as activity.`,
    };
  }

  return {
    kind: "other",
    content: `**Error:** ${msg || String(err)}`,
  };
}

function estimateTokens(text: string): number {
  // Rough heuristic: ~4 chars per token for English
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}

function formatMetrics(m: ChatMetrics): string {
  const parts: string[] = [];
  parts.push(`req ${formatMs(m.reqMs)}`);
  if (m.mode === "search" && m.results !== undefined) {
    parts.push(`${formatNum(m.results)} result${m.results === 1 ? "" : "s"}`);
  } else if (m.tokens) {
    parts.push(`${formatNum(m.tokens)} tok`);
  }
  if (m.bytes) parts.push(formatBytes(m.bytes));
  if (m.errorKind) parts.push(m.errorKind);
  return parts.join(" · ");
}

/**
 * Best-effort title for the "Save as Note" button when the LLM didn't
 * supply one in obsidian_metadata.title. Prefers an H1 heading at the
 * top of the body; falls back to the first sentence, truncated to 60
 * chars; finally to a generic label.
 */
function deriveTitleFromMarkdown(body: string): string {
  if (!body) return "Glean Response";
  const headingMatch = body.match(/^\s*#+\s+(.+?)\s*$/m);
  if (headingMatch) return headingMatch[1].trim();
  const firstLine = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstLine) {
    const sentence = firstLine.split(/(?<=[.?!])\s/)[0];
    return sentence.length > 60 ? `${sentence.substring(0, 57)}...` : sentence;
  }
  return "Glean Response";
}

/**
 * Tooltip shown on the Save-as-Note button so the user can preview
 * the title and tags that will land in the file before they click.
 */
function buildSaveTooltip(title: string, tags: string[]): string {
  const lines = [`Save as "${title}"`];
  if (tags.length > 0) {
    lines.push(`Tags: ${tags.map((t) => `#${t}`).join(" ")}`);
  }
  return lines.join("\n");
}

/**
 * Build a YAML frontmatter block from a flat field map. Skips empty
 * arrays and undefined values. Tags render as a YAML list, summary as
 * a quoted string.
 */
function buildFrontmatter(fields: {
  source?: string;
  date?: string;
  tags?: string[];
  summary?: string;
}): string {
  const lines: string[] = ["---"];
  if (fields.source) lines.push(`source: ${fields.source}`);
  if (fields.date) lines.push(`date: ${fields.date}`);
  if (fields.tags && fields.tags.length > 0) {
    lines.push("tags:");
    for (const t of fields.tags) lines.push(`  - ${t}`);
  }
  if (fields.summary) {
    // Quote and escape — summaries can contain colons or quotes.
    const escaped = fields.summary.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push(`summary: "${escaped}"`);
  }
  lines.push("---", "");
  return lines.join("\n") + "\n";
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
  messages: {
    author?: string;
    messageType?: string;
    fragments?: { text?: string }[];
  }[],
): string | null {
  const aiMessages = messages.filter(
    (m) => m.author === "GLEAN_AI" || m.author === "ASSISTANT",
  );
  // Prefer the last CONTENT message (the actual answer); fall back to the
  // last AI message; final fall back to the very last message. This matches
  // Glean's multi-message agent shape where intermediate UPDATE messages
  // carry status like "Searching teammates" before the final answer.
  const contentMsg = [...aiMessages]
    .reverse()
    .find((m) => m.messageType === "CONTENT");
  const aiMsg =
    contentMsg ??
    aiMessages[aiMessages.length - 1] ??
    messages[messages.length - 1];
  if (!aiMsg?.fragments) return null;
  const texts = aiMsg.fragments.map((f) => f.text).filter((t): t is string => !!t);
  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * Extract the LLM's natural-markdown reply from Glean's nested YAML
 * blob.
 *
 * Glean's MCP `chat` tool wraps the response in a YAML-like dump under
 * the standard MCP `content[0].text` field. For agent-style queries
 * the YAML carries multiple `messages[]` entries:
 *  - several intermediate `messageType: UPDATE` (e.g.
 *    "**Searching teammates**", "**Reading:** ", etc.)
 *  - exactly one final `messageType: CONTENT` whose `fragments[]`
 *    array holds the answer
 *
 * Inside the CONTENT message's fragments, the LLM's response is split
 * around inline citations — alternating `text` fragments with
 * `citation` / `{}` fragments. To reconstruct the natural markdown
 * reply we just concatenate every `text:` fragment in that block, in
 * order. (No JSON parsing — we no longer wrap the LLM response in a
 * JSON envelope.)
 */
function assembleMarkdownFromContent(rawText: string): string | null {
  const contentIdx = rawText.lastIndexOf("messageType: CONTENT");
  if (contentIdx < 0) return null;

  // Walk back to the start of this message block. Top-level messages
  // in the `messages[]` array start with a newline + two-space indent
  // + bare `-` on its own line. If we can't find it, scan from the
  // start of the text — finding too much is fine because the regex
  // already filters non-text-fragment lines.
  const before = rawText.substring(0, contentIdx);
  const blockStart = before.lastIndexOf("\n  -\n");
  const blockText = rawText.substring(
    blockStart >= 0 ? blockStart : 0,
    contentIdx,
  );

  // Match every text fragment. YAML shapes for "this fragment is text":
  //   - text: "..."
  //   text: "..."
  //   fragments[N]{text}:\n      "..."
  // The captured value is the JSON-encoded string (escapes preserved);
  // JSON.parse decodes it to its real characters.
  const textRe =
    /(?:fragments\[\d+\]\{text\}:|(?:^|\n)[ \t]*-?[ \t]*text:)\s*\r?\n?\s*"((?:\\.|[^"\\])*)"/g;

  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = textRe.exec(blockText)) !== null) {
    try {
      parts.push(JSON.parse('"' + m[1] + '"'));
    } catch {
      // unparseable fragment — skip
    }
  }
  if (parts.length === 0) return null;
  return parts.join("");
}

/**
 * Pull document citations out of Glean MCP's YAML blob. Each
 * `structuredResults` item carries a `document:` block with `title:`,
 * `url:`, and `datasource:` fields. Each `- citation:` block (per Glean's
 * deep-linked citations spec) carries a `sourceDocument:` plus a list of
 * `referenceRanges[].snippets[]` direct-quote snippets.
 *
 * We merge both: every unique document is one row in the Sources panel.
 * Documents that also appear in a citation block are marked `cited:true`
 * with their snippets attached, so the UI can sort them first and show
 * the direct quotes.
 *
 * See https://developers.glean.com/guides/chat/deep-linked-citations
 */
export interface ExtractedSource {
  title: string;
  url: string;
  datasource?: string;
  cited?: boolean;
  snippets?: string[];
}

function extractSourcesFromText(text: string): ExtractedSource[] {
  if (!text) return [];
  const citationsByUrl = extractCitationBlocksFromText(text);

  const sources: ExtractedSource[] = [];
  const seen = new Map<string, ExtractedSource>();

  // Split on each `document:` newline. The first segment is everything
  // before the first document; subsequent segments each begin with a
  // single document's body. Bound the look-ahead per segment so we
  // don't spill into the next block.
  const parts = text.split(/\bdocument:\s*\n/);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i].split("\n").slice(0, 18).join("\n");

    const title = matchYamlField(block, "title");
    const url = matchYamlField(block, "url");
    const datasource = matchYamlField(block, "datasource");

    if (!title || !url) continue;
    const cleanUrl = url.trim();

    // Dedup by URL but allow a later occurrence (which may carry the
    // citation marker) to overwrite/upgrade the entry.
    const existing = seen.get(cleanUrl);
    const citation = citationsByUrl.get(cleanUrl);
    const entry: ExtractedSource = existing ?? {
      title,
      url: cleanUrl,
      datasource: datasource ?? undefined,
    };
    if (citation) {
      entry.cited = true;
      entry.snippets = citation.snippets;
    }
    if (!existing) {
      seen.set(cleanUrl, entry);
      sources.push(entry);
    }
  }
  return sources;
}

/**
 * Find every `- citation:` block in the response and pull its
 * `sourceDocument.url` plus all `referenceRanges[].snippets[].text`
 * values. Returns a map of url → snippets[].
 *
 * The YAML emitted by the MCP server looks like:
 *   - citation:
 *       referenceRanges[N]:
 *         - snippets[N]{snippet,text}:
 *           "","# Get started – click, search, or ask!"
 *           "",The easiest way is to head over to the Directory tab.
 *       sourceDocument:
 *         datasource: gleanwebsite
 *         id: ...
 *         title: "..."
 *         url: "..."
 *
 * Each snippet line is a `(snippetField, textField)` pair; we extract
 * the text part. The snippetField is typically empty.
 */
function extractCitationBlocksFromText(
  text: string,
): Map<string, { snippets: string[] }> {
  const out = new Map<string, { snippets: string[] }>();
  if (!text) return out;

  const citationRe = /^([ \t]+)-\s*citation:\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = citationRe.exec(text)) !== null) {
    const indent = m[1].length;
    const after = text.substring(m.index + m[0].length);

    // Collect lines until we hit one at the same or shallower indent
    // (i.e. the next sibling fragment).
    const lines = after.split("\n");
    const blockLines: string[] = [];
    for (const line of lines) {
      if (line.trim().length === 0) {
        blockLines.push(line);
        continue;
      }
      const leading = line.match(/^[ \t]*/)?.[0].length ?? 0;
      if (leading <= indent) break;
      blockLines.push(line);
    }
    const block = blockLines.join("\n");

    const url = matchYamlField(block, "url");
    if (!url) continue;

    // Snippet lines: indented `"<snippet>","<text>"` pairs. The text
    // field may be quoted or bare.
    const snippets: string[] = [];
    for (const line of block.split("\n")) {
      const t = parseSnippetLine(line);
      if (t) snippets.push(t);
    }
    if (snippets.length === 0) continue;
    out.set(url.trim(), { snippets });
  }
  return out;
}

/**
 * Parse one `"<snippet>","<text>"` (or unquoted text) line and return
 * the text field, or null if the line isn't a snippet.
 */
function parseSnippetLine(line: string): string | null {
  const trimmed = line.replace(/^[ \t]+/, "");
  if (!trimmed.startsWith('"')) return null;

  // Skip the snippet field (the first quoted string).
  let i = 1;
  let escaped = false;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (escaped) {
      escaped = false;
      i++;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      break;
    }
    i++;
  }
  if (trimmed[i] !== ",") return null;
  i++;
  while (i < trimmed.length && (trimmed[i] === " " || trimmed[i] === "\t")) {
    i++;
  }
  if (i >= trimmed.length) return null;

  // Read the text field. Quoted -> JSON.parse; bare -> rest of line.
  if (trimmed[i] === '"') {
    const start = i;
    i++;
    let escaped2 = false;
    while (i < trimmed.length) {
      const ch = trimmed[i];
      if (escaped2) {
        escaped2 = false;
        i++;
        continue;
      }
      if (ch === "\\") {
        escaped2 = true;
        i++;
        continue;
      }
      if (ch === '"') {
        i++;
        break;
      }
      i++;
    }
    const quoted = trimmed.substring(start, i);
    try {
      return JSON.parse(quoted);
    } catch {
      return quoted.slice(1, -1);
    }
  }
  return trimmed.substring(i).trim();
}

/**
 * Match a YAML key in a block. Handles both quoted ("Some title with
 * spaces") and bare (gmailnative) value forms.
 */
function matchYamlField(block: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^\\s*${escaped}:\\s*("(?:\\\\.|[^"\\\\])*"|\\S[^\\n]*)`,
    "m",
  );
  const m = re.exec(block);
  if (!m) return null;
  const v = m[1];
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v.trim();
}

// ===================================================================
// Search response YAML parser (Glean MCP `search` tool)
// ===================================================================

/**
 * Walk Glean's YAML search blob and yield one GleanSearchResult per
 * top-level document. We split on document boundaries first so each
 * field lookup is scoped to the right document — naively scanning the
 * whole blob would pick up nested `title:` fields from
 * `similarResults.visibleResults[]` and attribute them to the wrong
 * row.
 */
function parseSearchYamlBlob(text: string): GleanSearchResult[] {
  const blocks = splitDocumentBlocks(text);
  const results: GleanSearchResult[] = [];
  for (const block of blocks) {
    // Normalize: strip the leading `  - ` (or `  -`) so every doc-level
    // field lives at exactly 4-space indent. This lets us anchor field
    // matches at column 4 and ignore deeper-nested values like
    // similarResults.visibleResults[*].title.
    const normalized = block.replace(/^  -(?: |$)/m, "    ");

    const title = matchYamlFieldAtIndent(normalized, "title", 4);
    if (!title) continue;
    const url = matchYamlFieldAtIndent(normalized, "url", 4) ?? "";
    const datasource = matchYamlFieldAtIndent(normalized, "datasource", 4) ?? "";
    const updateTime = matchYamlFieldAtIndent(normalized, "updateTime", 4)
      ?? matchYamlFieldAtIndent(normalized, "createTime", 4)
      ?? undefined;
    // Prefer updatedBy.name (matches the web UI's "Updated … by …"
    // attribution); fall back to owner.name, then ownedAndUpdatedBy.name.
    const owner =
      matchNestedYamlNameField(normalized, "updatedBy", 4) ??
      matchNestedYamlNameField(normalized, "owner", 4) ??
      matchNestedYamlNameField(normalized, "ownedAndUpdatedBy", 4) ??
      undefined;
    const snippet = extractFirstUsefulSnippet(normalized) ?? "";

    results.push({
      title,
      url,
      snippet,
      source: datasource,
      lastUpdated: updateTime,
      owner,
    });
  }
  return results;
}

/**
 * Split a Glean search YAML blob into one chunk per top-level document.
 *
 * The structure is:
 *   documents[N]:
 *     - <field>: ...     <- new doc starts here (2-space + dash)
 *       <field>: ...
 *     - <field>: ...     <- next doc
 *
 * We track entry into the documents array, then capture every line up
 * to (but not including) the next `  - ` boundary or a column-0 key
 * (which would mean the documents block ended).
 */
function splitDocumentBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let inArray = false;
  let current: string[] | null = null;

  const flush = (): void => {
    if (current && current.length > 0) blocks.push(current.join("\n"));
    current = null;
  };

  for (const line of lines) {
    if (/^documents\[\d+\]:\s*$/.test(line)) {
      flush();
      inArray = true;
      continue;
    }
    if (!inArray) continue;

    // New document boundary — `  - <field>:` or bare `  -` (when the
    // first field is a nested object like `channel:` for slack docs).
    if (/^  - /.test(line) || /^  -\s*$/.test(line)) {
      flush();
      current = [line];
      continue;
    }

    if (current === null) continue;

    if (line.length === 0 || line.startsWith("    ")) {
      current.push(line);
      continue;
    }

    // A column-0 (or shallower than 4) non-empty line marks the end of
    // the documents array (top-level keys like `messages:` or
    // `chatId:`). Stop collecting here.
    flush();
    inArray = false;
  }
  flush();
  return blocks;
}

/**
 * Match a YAML field whose key sits at exactly the given indent level.
 * Used to scope lookups to the document's own fields and skip any
 * deeper-nested copies of the same key (e.g. nested `title:` inside
 * similarResults.visibleResults[]).
 */
function matchYamlFieldAtIndent(
  block: string,
  key: string,
  indent: number,
): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^[ \\t]{${indent}}${escaped}:[ \\t]*("(?:\\\\.|[^"\\\\])*"|[^\\n]*)`,
    "m",
  );
  const m = re.exec(block);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return null;
  if (raw.startsWith('"')) {
    // Take only the first quoted string — strips trailing junk like
    // ",foo" if a value got concatenated with a CSV-style sibling.
    const closeIdx = findClosingQuote(raw, 0);
    const slice = closeIdx > 0 ? raw.substring(0, closeIdx + 1) : raw;
    try {
      return JSON.parse(slice);
    } catch {
      return slice.replace(/^"|"$/g, "");
    }
  }
  return raw;
}

/**
 * Read `<parent>.name` where `<parent>` is itself a nested object at
 * the given indent (i.e. its `name:` child is at indent + 2).
 */
function matchNestedYamlNameField(
  block: string,
  parent: string,
  indent: number,
): string | null {
  const escaped = parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^[ \\t]{${indent}}${escaped}:[ \\t]*$`, "m");
  const m = re.exec(block);
  if (!m) return null;
  const after = block.substring(m.index + m[0].length);
  const nameRe = new RegExp(`^[ \\t]{${indent + 2}}name:[ \\t]*(.+?)\\s*$`, "m");
  const nm = nameRe.exec(after);
  if (!nm) return null;
  const v = nm[1];
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v.trim();
}

/**
 * Pick the first snippet that's actually informative — skip image
 * tags, image-file pseudo-headings (`# image1.png`), and the "we do
 * not have snippets for this document" boilerplate.
 *
 * Snippets appear in two YAML shapes:
 *   snippets[N]: "first",second,"third"        (inline CSV)
 *   snippets[N]:
 *     - "first"                                 (multi-line list)
 *     - second
 */
function extractFirstUsefulSnippet(block: string): string | null {
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^[ \t]{4}snippets\[\d+\]:[ \t]*(.*)$/);
    if (!m) continue;
    const inline = m[1];
    const candidates: string[] = [];
    if (inline.length > 0) {
      candidates.push(...splitInlineSnippets(inline));
    } else {
      for (let j = i + 1; j < lines.length && candidates.length < 6; j++) {
        const itemLine = lines[j];
        const im = itemLine.match(/^[ \t]{6}-[ \t]*(.*)$/);
        if (im) {
          candidates.push(parseQuotedOrBareYaml(im[1]));
          continue;
        }
        // Indent dropped back to a doc field — end of this snippet list.
        if (itemLine.length > 0 && !itemLine.startsWith("        ")) break;
      }
    }
    for (const c of candidates) {
      const cleaned = cleanSnippetText(c);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

/**
 * Split an inline `"a","b",c` snippet payload into its component
 * fields. Quotes wrap most fields; bare ones (no commas inside) appear
 * between commas.
 */
function splitInlineSnippets(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    // Skip whitespace and one leading comma.
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
    if (s[i] === ",") {
      i++;
      continue;
    }
    if (s[i] === '"') {
      const end = findClosingQuote(s, i);
      if (end < 0) break;
      const quoted = s.substring(i, end + 1);
      try {
        out.push(JSON.parse(quoted));
      } catch {
        out.push(quoted.slice(1, -1));
      }
      i = end + 1;
    } else {
      const next = s.indexOf(",", i);
      const end = next < 0 ? s.length : next;
      const bare = s.substring(i, end).trim();
      if (bare) out.push(bare);
      i = end;
    }
  }
  return out;
}

function findClosingQuote(s: string, start: number): number {
  if (s[start] !== '"') return -1;
  let i = start + 1;
  let escaped = false;
  while (i < s.length) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      i++;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      i++;
      continue;
    }
    if (ch === '"') return i;
    i++;
  }
  return -1;
}

function parseQuotedOrBareYaml(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"')) {
    const close = findClosingQuote(trimmed, 0);
    if (close > 0) {
      const quoted = trimmed.substring(0, close + 1);
      try {
        return JSON.parse(quoted);
      } catch {
        return quoted.slice(1, -1);
      }
    }
  }
  return trimmed;
}

/**
 * Decide whether a raw snippet is worth showing. Image tags get their
 * alt text mined; image-file pseudo-headings and boilerplate are
 * dropped; everything else has its HTML stripped and is collapsed onto
 * a single line.
 */
function cleanSnippetText(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;

  const imgAlt = text.match(/^<img\s[^>]*\balt=(?:"([^"]*)"|'([^']*)')/i);
  if (imgAlt) {
    text = (imgAlt[1] ?? imgAlt[2] ?? "").trim();
    if (!text) return null;
  } else if (text.includes("<")) {
    text = text.replace(/<[^>]+>/g, "").trim();
    if (!text) return null;
  }

  if (/^#\s+image\d*\.\w+\s*$/i.test(text)) return null;
  if (/^#\s+image\d+\s*$/i.test(text)) return null;
  if (text.startsWith("We do not have snippets for this document")) return null;

  // Strip leading block-starters so snippets don't accidentally render
  // as headings (`# foo`), bullets (`- foo`, `* foo`), or blockquotes
  // (`> foo`) inside the result line.
  text = text
    .replace(/^#+\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^>\s+/, "")
    .trim();
  if (!text) return null;

  return text.replace(/\s+/g, " ").trim();
}

/**
 * Render an ISO timestamp as a short relative-time label ("today",
 * "3d ago", "2w ago", "5mo ago", "2y ago"). Returns null on parse
 * failure so callers can omit the field entirely.
 */
function formatRelativeTime(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diffMs = Date.now() - t;
  const sec = diffMs / 1000;
  if (sec < 60) return "just now";
  const min = sec / 60;
  if (min < 60) return `${Math.floor(min)}m ago`;
  const hr = min / 60;
  if (hr < 24) return `${Math.floor(hr)}h ago`;
  const day = hr / 24;
  if (day < 1.5) return "yesterday";
  if (day < 7) return `${Math.floor(day)}d ago`;
  if (day < 30) return `${Math.floor(day / 7)}w ago`;
  if (day < 365) return `${Math.floor(day / 30)}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 1).trimEnd() + "…";
}


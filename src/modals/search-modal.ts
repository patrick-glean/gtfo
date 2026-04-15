import { Modal, Notice, debounce } from "obsidian";
import type GtfoPlugin from "../main";
import type { GleanSearchResult } from "../types";

export class GleanSearchModal extends Modal {
  private plugin: GtfoPlugin;
  private inputEl: HTMLInputElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private results: GleanSearchResult[] = [];
  private selectedIndex = 0;

  constructor(plugin: GtfoPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("gtfo-search-modal");

    this.inputEl = contentEl.createEl("input", {
      type: "text",
      placeholder: "Search Glean...",
      cls: "gtfo-modal-input",
    });

    this.resultsEl = contentEl.createDiv({ cls: "gtfo-modal-results" });

    const debouncedSearch = debounce(
      (query: string) => this.executeSearch(query),
      300,
      true,
    );

    this.inputEl.addEventListener("input", () => {
      const query = this.inputEl?.value?.trim();
      if (query && query.length >= 2) {
        debouncedSearch(query);
      }
    });

    this.inputEl.addEventListener("keydown", (e) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          this.selectedIndex = Math.min(
            this.selectedIndex + 1,
            this.results.length - 1,
          );
          this.highlightSelected();
          break;
        case "ArrowUp":
          e.preventDefault();
          this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
          this.highlightSelected();
          break;
        case "Enter":
          e.preventDefault();
          if (this.results[this.selectedIndex]) {
            if (e.shiftKey) {
              this.insertResult(this.results[this.selectedIndex]);
            } else {
              this.openResult(this.results[this.selectedIndex]);
            }
          }
          break;
        case "Escape":
          this.close();
          break;
      }
    });

    this.inputEl.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async executeSearch(query: string): Promise<void> {
    if (!this.plugin.mcpClient.connected) {
      new Notice("Not connected to Glean");
      return;
    }

    try {
      const response = await this.plugin.mcpClient.search(query);
      this.results = this.parseResults(response);
      this.selectedIndex = 0;
      this.renderResults();
    } catch (e) {
      if (this.resultsEl) {
        this.resultsEl.empty();
        this.resultsEl.createDiv({
          cls: "gtfo-modal-error",
          text: `Search failed: ${e}`,
        });
      }
    }
  }

  private renderResults(): void {
    if (!this.resultsEl) return;
    this.resultsEl.empty();

    if (this.results.length === 0) {
      this.resultsEl.createDiv({
        cls: "gtfo-modal-empty",
        text: "No results",
      });
      return;
    }

    this.resultsEl.createDiv({
      cls: "gtfo-modal-hint",
      text: "Enter to open | Shift+Enter to insert | Arrow keys to navigate",
    });

    for (let i = 0; i < this.results.length; i++) {
      const result = this.results[i];
      const item = this.resultsEl.createDiv({
        cls: `gtfo-modal-result-item ${i === this.selectedIndex ? "gtfo-modal-result-item--selected" : ""}`,
      });

      if (result.source) {
        item.createSpan({
          cls: "gtfo-modal-result-source",
          text: result.source,
        });
      }

      item.createSpan({
        cls: "gtfo-modal-result-title",
        text: result.title,
      });

      if (result.snippet) {
        item.createDiv({
          cls: "gtfo-modal-result-snippet",
          text: result.snippet.substring(0, 120),
        });
      }

      item.addEventListener("click", () => this.openResult(result));
      item.addEventListener("mouseenter", () => {
        this.selectedIndex = i;
        this.highlightSelected();
      });
    }
  }

  private highlightSelected(): void {
    if (!this.resultsEl) return;
    const items = this.resultsEl.querySelectorAll(".gtfo-modal-result-item");
    items.forEach((item, i) => {
      item.toggleClass(
        "gtfo-modal-result-item--selected",
        i === this.selectedIndex,
      );
    });
  }

  private openResult(result: GleanSearchResult): void {
    if (result.url) {
      window.open(result.url);
    }
    this.close();
  }

  private async insertResult(result: GleanSearchResult): Promise<void> {
    const parts: string[] = [];
    if (result.url) {
      parts.push(`[${result.title}](${result.url})`);
    } else {
      parts.push(`**${result.title}**`);
    }
    if (result.snippet) {
      parts.push(`> ${result.snippet}`);
    }

    const inserted = await this.plugin.vaultTools.insertAtCursor(
      parts.join("\n"),
    );
    if (inserted) {
      new Notice("Inserted into note");
    } else {
      new Notice("No active editor");
    }
    this.close();
  }

  private parseResults(response: unknown): GleanSearchResult[] {
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
      return [{ title: "Results", url: "", snippet: textContent.text, source: "Glean" }];
    }
  }
}

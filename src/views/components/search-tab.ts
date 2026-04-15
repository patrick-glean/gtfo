import { Notice, debounce } from "obsidian";
import type GtfoPlugin from "../../main";
import { ResultCard } from "./result-card";
import type { GleanSearchResult } from "../../types";

export class SearchTab {
  private container: HTMLElement;
  private plugin: GtfoPlugin;
  private resultsEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;

  constructor(container: HTMLElement, plugin: GtfoPlugin) {
    this.container = container;
    this.plugin = plugin;
  }

  render(): void {
    const wrapper = this.container.createDiv({ cls: "gtfo-search-wrapper" });

    const inputContainer = wrapper.createDiv({ cls: "gtfo-search-input-container" });
    this.inputEl = inputContainer.createEl("input", {
      type: "text",
      placeholder: "Search Glean...",
      cls: "gtfo-search-input",
    });

    this.resultsEl = wrapper.createDiv({ cls: "gtfo-search-results" });

    const debouncedSearch = debounce(
      (query: string) => this.executeSearch(query),
      300,
      true,
    );

    this.inputEl.addEventListener("input", () => {
      const query = this.inputEl?.value?.trim();
      if (query && query.length >= 2) {
        debouncedSearch(query);
      } else if (this.resultsEl) {
        this.resultsEl.empty();
      }
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const query = this.inputEl?.value?.trim();
        if (query) {
          this.executeSearch(query);
        }
      }
    });

    if (!this.plugin.mcpClient.connected) {
      this.resultsEl.createDiv({
        cls: "gtfo-search-placeholder",
        text: "Connect to Glean in Settings to search.",
      });
    }
  }

  private async executeSearch(query: string): Promise<void> {
    if (!this.resultsEl) return;

    if (!this.plugin.mcpClient.connected) {
      new Notice("Not connected to Glean. Configure in Settings.");
      return;
    }

    this.resultsEl.empty();
    this.resultsEl.createDiv({ cls: "gtfo-search-loading", text: "Searching..." });

    try {
      const response = await this.plugin.mcpClient.search(query);
      this.resultsEl.empty();

      const results = this.parseResults(response);

      if (results.length === 0) {
        this.resultsEl.createDiv({
          cls: "gtfo-search-placeholder",
          text: "No results found.",
        });
        return;
      }

      for (const result of results) {
        const card = new ResultCard(this.resultsEl, result, this.plugin);
        card.render();
      }
    } catch (e) {
      this.resultsEl.empty();
      this.resultsEl.createDiv({
        cls: "gtfo-search-error",
        text: `Search failed: ${e}`,
      });
    }
  }

  private parseResults(response: unknown): GleanSearchResult[] {
    if (!response || typeof response !== "object") return [];

    const resp = response as { content?: { type: string; text: string }[] };
    if (!resp.content) return [];

    const textContent = resp.content.find((c) => c.type === "text");
    if (!textContent) return [];

    try {
      const parsed = JSON.parse(textContent.text);
      if (Array.isArray(parsed)) {
        return parsed.map((r: Record<string, string>) => ({
          title: r.title || "Untitled",
          url: r.url || "",
          snippet: r.snippet || r.description || "",
          source: r.source || r.datasource || "",
          lastUpdated: r.lastUpdated || r.updateTime || undefined,
        }));
      }
      if (parsed.results && Array.isArray(parsed.results)) {
        return parsed.results.map((r: Record<string, string>) => ({
          title: r.title || "Untitled",
          url: r.url || "",
          snippet: r.snippet || r.description || "",
          source: r.source || r.datasource || "",
          lastUpdated: r.lastUpdated || r.updateTime || undefined,
        }));
      }
    } catch {
      // Response may be plain text from Glean MCP
      return [{
        title: "Search Results",
        url: "",
        snippet: textContent.text,
        source: "Glean",
      }];
    }

    return [];
  }
}

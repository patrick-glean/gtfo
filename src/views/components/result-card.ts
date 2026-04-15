import { Notice } from "obsidian";
import type GtfoPlugin from "../../main";
import type { GleanSearchResult } from "../../types";

export class ResultCard {
  private container: HTMLElement;
  private result: GleanSearchResult;
  private plugin: GtfoPlugin;

  constructor(
    container: HTMLElement,
    result: GleanSearchResult,
    plugin: GtfoPlugin,
  ) {
    this.container = container;
    this.result = result;
    this.plugin = plugin;
  }

  render(): void {
    const card = this.container.createDiv({ cls: "gtfo-result-card" });

    const header = card.createDiv({ cls: "gtfo-result-header" });

    if (this.result.source) {
      header.createSpan({
        cls: "gtfo-result-source",
        text: this.result.source,
      });
    }

    if (this.result.lastUpdated) {
      header.createSpan({
        cls: "gtfo-result-date",
        text: this.result.lastUpdated,
      });
    }

    const titleEl = card.createEl("a", {
      cls: "gtfo-result-title",
      text: this.result.title,
    });
    if (this.result.url) {
      titleEl.href = this.result.url;
      titleEl.addEventListener("click", (e) => {
        e.preventDefault();
        window.open(this.result.url);
      });
    }

    if (this.result.snippet) {
      card.createDiv({
        cls: "gtfo-result-snippet",
        text: this.result.snippet,
      });
    }

    const actions = card.createDiv({ cls: "gtfo-result-actions" });

    const insertBtn = actions.createEl("button", {
      text: "Insert to Note",
      cls: "gtfo-result-btn",
    });
    insertBtn.addEventListener("click", () => this.insertToNote());

    const copyBtn = actions.createEl("button", {
      text: "Copy",
      cls: "gtfo-result-btn",
    });
    copyBtn.addEventListener("click", () => this.copyToClipboard());
  }

  private async insertToNote(): Promise<void> {
    const markdown = this.formatAsMarkdown();
    const inserted = await this.plugin.vaultTools.insertAtCursor(markdown);
    if (inserted) {
      new Notice("Inserted into note");
    } else {
      new Notice("No active editor -- open a note first");
    }
  }

  private async copyToClipboard(): Promise<void> {
    const markdown = this.formatAsMarkdown();
    await navigator.clipboard.writeText(markdown);
    new Notice("Copied to clipboard");
  }

  private formatAsMarkdown(): string {
    const parts: string[] = [];
    if (this.result.url) {
      parts.push(`[${this.result.title}](${this.result.url})`);
    } else {
      parts.push(`**${this.result.title}**`);
    }
    if (this.result.snippet) {
      parts.push(`> ${this.result.snippet}`);
    }
    if (this.result.source) {
      parts.push(`*Source: ${this.result.source}*`);
    }
    return parts.join("\n");
  }
}

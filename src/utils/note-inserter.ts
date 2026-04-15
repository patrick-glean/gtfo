import type { GleanSearchResult, ChatMessage } from "../types";
import type { VaultTools } from "../tools/vault-tools";

export class NoteInserter {
  constructor(private vaultTools: VaultTools) {}

  async insertSearchResult(result: GleanSearchResult): Promise<boolean> {
    return this.vaultTools.insertAtCursor(
      this.formatSearchResult(result),
    );
  }

  async insertChatResponse(content: string): Promise<boolean> {
    const markdown = `> [!quote] Glean\n> ${content.split("\n").join("\n> ")}`;
    return this.vaultTools.insertAtCursor(markdown);
  }

  async saveSearchResultsAsNote(
    results: GleanSearchResult[],
    path: string,
    query: string,
  ): Promise<void> {
    const lines = [
      `# Glean Search: ${query}`,
      "",
      `*${new Date().toLocaleString()}*`,
      "",
      ...results.map((r) => this.formatSearchResult(r)),
    ];
    await this.vaultTools.createNote(path, lines.join("\n"));
  }

  async saveChatAsNote(
    messages: ChatMessage[],
    path: string,
  ): Promise<void> {
    const lines = [
      "# Glean Chat",
      "",
      `*${new Date().toLocaleString()}*`,
      "",
    ];

    for (const msg of messages) {
      const role = msg.role === "user" ? "You" : "Glean";
      lines.push(`### ${role}`);
      lines.push("");
      lines.push(msg.content);
      lines.push("");
    }

    await this.vaultTools.createNote(path, lines.join("\n"));
  }

  private formatSearchResult(result: GleanSearchResult): string {
    const parts: string[] = [];
    if (result.url) {
      parts.push(`- [${result.title}](${result.url})`);
    } else {
      parts.push(`- **${result.title}**`);
    }
    if (result.snippet) {
      parts.push(`  > ${result.snippet}`);
    }
    if (result.source) {
      parts.push(`  *Source: ${result.source}*`);
    }
    parts.push("");
    return parts.join("\n");
  }
}

import type { GleanSearchResult } from "../types";

export function resultToMarkdown(result: GleanSearchResult): string {
  const parts: string[] = [];
  if (result.url) {
    parts.push(`[${result.title}](${result.url})`);
  } else {
    parts.push(`**${result.title}**`);
  }
  if (result.snippet) {
    parts.push(`> ${result.snippet}`);
  }
  if (result.source) {
    parts.push(`*Source: ${result.source}*`);
  }
  return parts.join("\n");
}

export function resultsToMarkdownList(results: GleanSearchResult[]): string {
  return results.map(resultToMarkdown).join("\n\n---\n\n");
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
}

import type { ChatMessage } from "../../types";

export function formatChatMessage(msg: ChatMessage): string {
  const time = new Date(msg.timestamp).toLocaleTimeString();
  const role = msg.role === "user" ? "You" : "Glean";
  return `**${role}** (${time}):\n${msg.content}`;
}

export function chatMessagesToMarkdown(messages: ChatMessage[]): string {
  return messages.map(formatChatMessage).join("\n\n---\n\n");
}

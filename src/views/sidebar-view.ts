import { ItemView, WorkspaceLeaf } from "obsidian";
import type GtfoPlugin from "../main";
import { SearchTab } from "./components/search-tab";
import { ChatTab } from "./components/chat-tab";
import { TerminalTab } from "./components/terminal-tab";

export const VIEW_TYPE_GTFO = "gtfo-view";

type TabId = "search" | "chat" | "terminal";

export class GtfoSidebarView extends ItemView {
  plugin: GtfoPlugin;
  private activeTab: TabId = "search";
  private tabContainer: HTMLElement | null = null;
  private contentContainer: HTMLElement | null = null;

  private searchTab: SearchTab | null = null;
  private chatTab: ChatTab | null = null;
  private terminalTab: TerminalTab | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GtfoPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_GTFO;
  }

  getDisplayText(): string {
    return "GTFO";
  }

  getIcon(): string {
    return "search";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("gtfo-container");

    this.tabContainer = container.createDiv({ cls: "gtfo-tabs" });
    this.contentContainer = container.createDiv({ cls: "gtfo-content" });

    this.renderTabs();
    this.switchTab(this.activeTab);
  }

  async onClose(): Promise<void> {
    this.terminalTab?.destroy();
    this.searchTab = null;
    this.chatTab = null;
    this.terminalTab = null;
  }

  private renderTabs(): void {
    if (!this.tabContainer) return;
    this.tabContainer.empty();

    const tabs: { id: TabId; label: string; icon: string }[] = [
      { id: "search", label: "Search", icon: "search" },
      { id: "chat", label: "Chat", icon: "message-circle" },
      { id: "terminal", label: "Terminal", icon: "terminal" },
    ];

    for (const tab of tabs) {
      const tabEl = this.tabContainer.createDiv({
        cls: `gtfo-tab ${this.activeTab === tab.id ? "gtfo-tab--active" : ""}`,
      });
      tabEl.createSpan({ text: tab.label });
      tabEl.addEventListener("click", () => this.switchTab(tab.id));
    }
  }

  private switchTab(tabId: TabId): void {
    this.activeTab = tabId;
    this.renderTabs();

    if (!this.contentContainer) return;
    this.contentContainer.empty();

    switch (tabId) {
      case "search":
        this.searchTab = new SearchTab(this.contentContainer, this.plugin);
        this.searchTab.render();
        break;
      case "chat":
        this.chatTab = new ChatTab(this.contentContainer, this.plugin);
        this.chatTab.render();
        break;
      case "terminal":
        this.terminalTab = new TerminalTab(this.contentContainer, this.plugin);
        this.terminalTab.render();
        break;
    }
  }
}

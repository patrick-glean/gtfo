import { ItemView, WorkspaceLeaf } from "obsidian";
import type GtfoPlugin from "../main";
import { ChatTab } from "./components/chat-tab";
import { TerminalTab } from "./components/terminal-tab";

export const VIEW_TYPE_GTFO = "gtfo-view";

type TabId = "chat" | "terminal";

interface TabDef {
  id: TabId;
  label: string;
  icon: string;
}

const TABS: TabDef[] = [
  { id: "chat", label: "Chat", icon: "message-circle" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
];

export class GtfoSidebarView extends ItemView {
  plugin: GtfoPlugin;
  private activeTab: TabId = "chat";
  private tabContainer: HTMLElement | null = null;
  private tabPanels: Partial<Record<TabId, HTMLElement>> = {};
  private tabButtons: Partial<Record<TabId, HTMLElement>> = {};

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
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("gtfo-container");

    this.tabContainer = container.createDiv({ cls: "gtfo-tabs" });
    const contentContainer = container.createDiv({ cls: "gtfo-content" });

    this.renderTabButtons();

    // Create a persistent panel per tab, rendered once
    for (const tab of TABS) {
      const panel = contentContainer.createDiv({
        cls: `gtfo-tab-panel gtfo-tab-panel--${tab.id}`,
      });
      this.tabPanels[tab.id] = panel;
    }

    this.chatTab = new ChatTab(this.tabPanels.chat!, this.plugin);
    this.chatTab.render();

    this.terminalTab = new TerminalTab(this.tabPanels.terminal!, this.plugin);
    this.terminalTab.render();

    this.setActiveTab(this.activeTab);
  }

  async onClose(): Promise<void> {
    this.terminalTab?.destroy();
    this.chatTab = null;
    this.terminalTab = null;
    this.tabPanels = {};
    this.tabButtons = {};
  }

  private renderTabButtons(): void {
    if (!this.tabContainer) return;
    this.tabContainer.empty();
    this.tabButtons = {};

    for (const tab of TABS) {
      const tabEl = this.tabContainer.createDiv({
        cls: `gtfo-tab ${this.activeTab === tab.id ? "gtfo-tab--active" : ""}`,
      });
      tabEl.createSpan({ cls: "gtfo-tab-label", text: tab.label });
      tabEl.addEventListener("click", () => this.setActiveTab(tab.id));
      this.tabButtons[tab.id] = tabEl;
    }
  }

  private setActiveTab(tabId: TabId): void {
    this.activeTab = tabId;

    for (const tab of TABS) {
      const panel = this.tabPanels[tab.id];
      const btn = this.tabButtons[tab.id];
      if (panel) {
        panel.toggleClass("gtfo-tab-panel--active", tab.id === tabId);
      }
      if (btn) {
        btn.toggleClass("gtfo-tab--active", tab.id === tabId);
      }
    }

    // Let the active tab know it was activated (e.g. terminal needs to re-fit)
    if (tabId === "terminal") this.terminalTab?.onShow();
    if (tabId === "chat") this.chatTab?.onShow();
  }

  newChat(): void {
    this.setActiveTab("chat");
    this.chatTab?.newChat();
  }
}

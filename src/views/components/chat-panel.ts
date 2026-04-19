import type GtfoPlugin from "../../main";
import { ChatTab } from "./chat-tab";

interface ChatSessionEntry {
  id: string;
  title: string;
  bodyEl: HTMLElement;
  chat: ChatTab;
}

/**
 * Container for one or more concurrent chat sessions. Each session is
 * an independent ChatTab instance with its own message history,
 * pending request, Glean chatId, and open-file chip state. Only the
 * active session's body is visible; the others are kept in the DOM
 * (with display:none) so switching sessions is instant and preserves
 * scroll position, input drafts, and live "thinking" timers.
 *
 * The session-tab strip across the top mirrors the IDE-tab metaphor:
 * one tab per session with a close button, and a `+` to spawn a
 * fresh session. The first session is created automatically on render
 * so a brand-new sidebar already has somewhere to type.
 */
export class ChatPanel {
  private container: HTMLElement;
  private plugin: GtfoPlugin;
  private sessionsBarEl: HTMLElement | null = null;
  private bodiesEl: HTMLElement | null = null;
  private sessions: ChatSessionEntry[] = [];
  private activeId: string | null = null;
  /**
   * Counter used purely for the visible "Chat N" default label. Doesn't
   * decrement on close — closing Chat 2 and creating a new one yields
   * "Chat 4" if Chat 3 was already in use, which matches what every
   * tabbed editor does and avoids label re-use across the session log.
   */
  private nextChatNumber = 1;

  constructor(container: HTMLElement, plugin: GtfoPlugin) {
    this.container = container;
    this.plugin = plugin;
  }

  render(): void {
    const wrapper = this.container.createDiv({ cls: "gtfo-chat-panel" });
    this.sessionsBarEl = wrapper.createDiv({ cls: "gtfo-chat-sessions-bar" });
    this.bodiesEl = wrapper.createDiv({ cls: "gtfo-chat-sessions-bodies" });

    this.createSession();
  }

  /**
   * Forwarded by the sidebar view when the chat tab becomes active.
   * Delegates to the active session so its input gets focus and the
   * scroll position pins to the bottom.
   */
  onShow(): void {
    this.activeSession()?.chat.onShow();
  }

  /**
   * Tear down all sessions when the sidebar view closes. Each ChatTab
   * has workspace event subscriptions that need releasing, so this is
   * not just a DOM clear.
   */
  destroy(): void {
    for (const s of this.sessions) {
      s.chat.destroy();
    }
    this.sessions = [];
    this.activeId = null;
  }

  /**
   * Public entry point for the "GTFO: New chat" command and the
   * sidebar's `view.newChat()` hook. Creates a fresh session and
   * activates it, matching the user's expectation that "new chat"
   * always opens an empty conversation alongside whatever they had.
   */
  newChat(): void {
    this.createSession();
  }

  private activeSession(): ChatSessionEntry | null {
    return this.sessions.find((s) => s.id === this.activeId) ?? null;
  }

  private createSession(): void {
    if (!this.bodiesEl) return;
    const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const number = this.nextChatNumber++;
    const title = `Chat ${number}`;

    const bodyEl = this.bodiesEl.createDiv({ cls: "gtfo-chat-session-body" });
    const entry: ChatSessionEntry = {
      id,
      title,
      bodyEl,
      chat: new ChatTab(bodyEl, this.plugin, {
        onTitleChange: (next) => this.handleTitleChange(id, next),
      }),
    };
    entry.chat.render();
    this.sessions.push(entry);
    this.activate(id);
  }

  private handleTitleChange(id: string, next: string): void {
    const entry = this.sessions.find((s) => s.id === id);
    if (!entry) return;
    // Empty / whitespace-only titles fall back to the original "Chat N"
    // label so the tab strip never collapses to a blank pill.
    entry.title = next.trim() || entry.title;
    this.renderSessionsBar();
  }

  private activate(id: string): void {
    const target = this.sessions.find((s) => s.id === id);
    if (!target) return;
    this.activeId = id;
    for (const s of this.sessions) {
      // toggleClass + display rule keeps the inactive session's DOM
      // alive (so message history and input draft survive switches)
      // while only the active body participates in layout.
      s.bodyEl.toggleClass("gtfo-chat-session-body--active", s.id === id);
    }
    this.renderSessionsBar();
    target.chat.onShow();
  }

  private closeSession(id: string): void {
    if (this.sessions.length <= 1) {
      // Always keep one session alive — closing the last one and
      // leaving an empty panel would feel broken. Reset it instead.
      this.sessions[0]?.chat.newChat();
      return;
    }
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const closing = this.sessions[idx];
    closing.chat.destroy();
    closing.bodyEl.remove();
    this.sessions.splice(idx, 1);

    if (this.activeId === id) {
      const fallback = this.sessions[Math.max(0, idx - 1)];
      this.activate(fallback.id);
    } else {
      this.renderSessionsBar();
    }
  }

  private renderSessionsBar(): void {
    if (!this.sessionsBarEl) return;
    this.sessionsBarEl.empty();

    for (const s of this.sessions) {
      const tabEl = this.sessionsBarEl.createDiv({
        cls: `gtfo-chat-session-tab ${
          s.id === this.activeId ? "gtfo-chat-session-tab--active" : ""
        }`,
        attr: { title: s.title },
      });
      tabEl.createSpan({
        cls: "gtfo-chat-session-tab-title",
        text: s.title,
      });
      // Close button only renders when there's more than one session;
      // closing the last one would leave an empty panel and we already
      // re-route that to a reset above, but hiding the X removes the
      // dead-end affordance.
      if (this.sessions.length > 1) {
        const closeBtn = tabEl.createSpan({
          cls: "gtfo-chat-session-tab-close",
          text: "×",
          attr: { title: "Close this chat" },
        });
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeSession(s.id);
        });
      }
      tabEl.addEventListener("click", () => this.activate(s.id));
    }

    const newBtn = this.sessionsBarEl.createDiv({
      cls: "gtfo-chat-session-tab gtfo-chat-session-tab--new",
      attr: { title: "Start a new chat" },
    });
    newBtn.createSpan({ text: "+ New" });
    newBtn.addEventListener("click", () => this.createSession());
  }
}

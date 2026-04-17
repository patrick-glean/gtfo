import type GtfoPlugin from "../../main";
import { Notice } from "obsidian";

type XTermTerminal = {
  open: (el: HTMLElement) => void;
  write: (data: string) => void;
  clear: () => void;
  reset: () => void;
  onData: (callback: (data: string) => void) => { dispose: () => void };
  onResize: (callback: (size: { cols: number; rows: number }) => void) => { dispose: () => void };
  dispose: () => void;
  focus: () => void;
  options: Record<string, unknown>;
  cols: number;
  rows: number;
};

type FitAddon = {
  fit: () => void;
  activate: (terminal: XTermTerminal) => void;
  dispose: () => void;
};

export class TerminalTab {
  private container: HTMLElement;
  private plugin: GtfoPlugin;
  private terminal: XTermTerminal | null = null;
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private disposables: { dispose: () => void }[] = [];
  private terminalEl: HTMLElement | null = null;

  constructor(container: HTMLElement, plugin: GtfoPlugin) {
    this.container = container;
    this.plugin = plugin;
  }

  render(): void {
    const wrapper = this.container.createDiv({ cls: "gtfo-terminal-wrapper" });

    const toolbar = wrapper.createDiv({ cls: "gtfo-terminal-toolbar" });

    const newBtn = toolbar.createEl("button", {
      text: "New",
      cls: "gtfo-terminal-btn",
    });
    newBtn.addEventListener("click", () => this.restartShell());

    const killBtn = toolbar.createEl("button", {
      text: "Kill",
      cls: "gtfo-terminal-btn",
    });
    killBtn.addEventListener("click", () => this.plugin.terminalManager.kill());

    const clearBtn = toolbar.createEl("button", {
      text: "Clear",
      cls: "gtfo-terminal-btn",
    });
    clearBtn.addEventListener("click", () => {
      this.terminal?.clear();
      this.plugin.terminalManager.clearScrollback();
    });

    this.terminalEl = wrapper.createDiv({ cls: "gtfo-terminal" });

    this.initTerminal(this.terminalEl);
  }

  private async initTerminal(el: HTMLElement): Promise<void> {
    try {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");

      const cssColor = (varName: string): string => {
        const val = getComputedStyle(document.body).getPropertyValue(varName).trim();
        return val || "#000000";
      };

      this.terminal = new Terminal({
        fontSize: this.plugin.settings.terminalFontSize,
        fontFamily: "Menlo, Monaco, 'Courier New', monospace",
        cursorBlink: true,
        cursorStyle: "block",
        scrollback: 10000,
        convertEol: false,
        theme: {
          background: cssColor("--background-primary") || "#1e1e1e",
          foreground: cssColor("--text-normal") || "#dcdcdc",
          cursor: cssColor("--text-accent") || "#ffffff",
          selectionBackground: cssColor("--text-selection") || "#3a3a3a",
        },
        allowProposedApi: true,
      }) as unknown as XTermTerminal;

      this.fitAddon = new FitAddon() as unknown as FitAddon;
      (this.terminal as unknown as { loadAddon: (a: unknown) => void }).loadAddon(this.fitAddon);

      this.terminal.open(el);

      // Fit BEFORE spawning so the shell starts with correct size.
      // Otherwise zsh's PROMPT_EOL_MARK fills a line with spaces at the
      // wrong width, leaving stranded `%` marks after resize.
      await this.waitForLayout(el);
      try {
        this.fitAddon.fit();
      } catch (e) {
        console.error("[GTFO] initial fit failed:", e);
      }

      // Debounced resize for subsequent layout changes
      let resizeTimer: number | null = null;
      this.resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          if (this.fitAddon && this.terminal) {
            try {
              this.fitAddon.fit();
            } catch {
              // dimensions may be transiently zero
            }
          }
        }, 100);
      });
      this.resizeObserver.observe(el);

      // Connect UI <-> TerminalManager
      this.wireUpTerminal();

      if (!this.plugin.terminalManager.isRunning) {
        this.spawnShell();
      } else {
        // Reconnecting to an existing shell -- ensure size matches and redraw
        this.plugin.terminalManager.resize(this.terminal.cols, this.terminal.rows);
        this.terminal.write("\r");
      }

      this.terminal.focus();
    } catch (e) {
      el.createEl("p", {
        text: `Failed to initialize terminal: ${e}`,
        cls: "gtfo-terminal-error",
      });
    }
  }

  private wireUpTerminal(): void {
    if (!this.terminal) return;
    const { terminalManager } = this.plugin;

    // Clear any stale subscriptions
    for (const d of this.disposables) d.dispose();
    this.disposables = [];

    const unsubData = terminalManager.onData((data) => {
      this.terminal?.write(data);
    });
    this.disposables.push({ dispose: unsubData });

    const inputSub = this.terminal.onData((data) => {
      terminalManager.write(data);
    });
    this.disposables.push(inputSub);

    const resizeSub = this.terminal.onResize(({ cols, rows }) => {
      terminalManager.resize(cols, rows);
    });
    this.disposables.push(resizeSub);

    const unsubExit = terminalManager.onExit((code) => {
      this.terminal?.write(
        `\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`,
      );
    });
    this.disposables.push({ dispose: unsubExit });
  }

  private spawnShell(): void {
    if (!this.terminal) return;

    const vaultPath =
      (this.plugin.app.vault.adapter as { getBasePath?: () => string })
        .getBasePath?.() || ".";

    try {
      // Spawn with the already-fitted dimensions so zsh's first prompt
      // is drawn at the correct width (no stranded PROMPT_EOL_MARK).
      this.plugin.terminalManager.spawn(
        this.plugin.settings,
        vaultPath,
        this.terminal.cols,
        this.terminal.rows,
      );
    } catch (e) {
      new Notice(`Terminal error: ${e}`);
      this.terminal.write(`\r\n\x1b[31mFailed to spawn shell: ${e}\x1b[0m\r\n`);
    }
  }

  /**
   * Resolve once the element has non-zero dimensions, so FitAddon.fit()
   * can compute correct cols/rows.
   */
  private waitForLayout(el: HTMLElement): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (el.clientWidth > 0 && el.clientHeight > 0) {
          resolve();
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }

  private restartShell(): void {
    this.plugin.terminalManager.kill();
    this.terminal?.reset();
    this.spawnShell();
  }

  onShow(): void {
    // Called when the terminal tab becomes visible.
    // Re-fit because the container may have been display:none.
    if (this.fitAddon && this.terminal) {
      setTimeout(() => {
        try {
          this.fitAddon?.fit();
          this.terminal?.focus();
        } catch {
          // dimensions not ready yet
        }
      }, 50);
    }
  }

  destroy(): void {
    // IMPORTANT: do NOT kill the shell on destroy. The TerminalManager lives
    // on the plugin and survives tab switches. Only clean up the view.
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.terminal?.dispose();
    this.fitAddon?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.terminalEl = null;
  }
}

import type GtfoPlugin from "../../main";
import { Notice } from "obsidian";

type XTermTerminal = {
  open: (el: HTMLElement) => void;
  write: (data: string) => void;
  onData: (callback: (data: string) => void) => { dispose: () => void };
  onResize: (callback: (size: { cols: number; rows: number }) => void) => { dispose: () => void };
  dispose: () => void;
  options: Record<string, unknown>;
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
    newBtn.addEventListener("click", () => this.spawnTerminal(wrapper));

    const killBtn = toolbar.createEl("button", {
      text: "Kill",
      cls: "gtfo-terminal-btn",
    });
    killBtn.addEventListener("click", () => this.killTerminal());

    const terminalEl = wrapper.createDiv({ cls: "gtfo-terminal" });

    this.initTerminal(terminalEl);
  }

  private async initTerminal(el: HTMLElement): Promise<void> {
    try {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");

      this.terminal = new Terminal({
        fontSize: this.plugin.settings.terminalFontSize,
        fontFamily: "Menlo, Monaco, 'Courier New', monospace",
        cursorBlink: true,
        cursorStyle: "block",
        theme: {
          background: "var(--background-primary)",
          foreground: "var(--text-normal)",
          cursor: "var(--text-accent)",
          selectionBackground: "var(--text-selection)",
        },
        allowProposedApi: true,
      }) as unknown as XTermTerminal;

      this.fitAddon = new FitAddon() as unknown as FitAddon;
      (this.terminal as unknown as { loadAddon: (a: unknown) => void }).loadAddon(this.fitAddon);

      this.terminal.open(el);

      requestAnimationFrame(() => {
        this.fitAddon?.fit();
      });

      this.resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          this.fitAddon?.fit();
        });
      });
      this.resizeObserver.observe(el);

      this.spawnTerminal(el.parentElement!);
    } catch (e) {
      el.createEl("p", {
        text: `Failed to initialize terminal: ${e}`,
        cls: "gtfo-terminal-error",
      });
    }
  }

  private spawnTerminal(wrapper: HTMLElement): void {
    if (!this.terminal) return;

    const { terminalManager } = this.plugin;

    if (terminalManager.isRunning) {
      terminalManager.kill();
    }

    const vaultPath = (this.plugin.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() || ".";

    try {
      terminalManager.spawn(this.plugin.settings, vaultPath);
    } catch (e) {
      new Notice(`Terminal error: ${e}`);
      this.terminal.write(`\r\n\x1b[31mFailed to spawn shell: ${e}\x1b[0m\r\n`);
      this.terminal.write("Run 'npm run rebuild-native' in the plugin directory.\r\n");
      return;
    }

    const unsub1 = terminalManager.onData((data) => {
      this.terminal?.write(data);
    });
    this.disposables.push({ dispose: unsub1 });

    const dataSub = this.terminal.onData((data) => {
      terminalManager.write(data);
    });
    this.disposables.push(dataSub);

    const resizeSub = this.terminal.onResize(({ cols, rows }) => {
      terminalManager.resize(cols, rows);
    });
    this.disposables.push(resizeSub);

    const unsub2 = terminalManager.onExit((code) => {
      this.terminal?.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
    });
    this.disposables.push({ dispose: unsub2 });
  }

  private killTerminal(): void {
    this.plugin.terminalManager.kill();
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.terminal?.dispose();
    this.fitAddon?.dispose();
    this.terminal = null;
    this.fitAddon = null;
  }
}

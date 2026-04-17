import type GtfoPlugin from "../../main";
import { Notice, Menu } from "obsidian";
import type { TerminalLaunchPreset } from "../../types";

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
  private initStarted = false;

  constructor(container: HTMLElement, plugin: GtfoPlugin) {
    this.container = container;
    this.plugin = plugin;
  }

  render(): void {
    const wrapper = this.container.createDiv({ cls: "gtfo-terminal-wrapper" });

    const toolbar = wrapper.createDiv({ cls: "gtfo-terminal-toolbar" });

    const launchBtn = toolbar.createEl("button", {
      text: "Launch ▾",
      cls: "gtfo-terminal-btn gtfo-terminal-btn--primary",
      attr: { title: "Run a preset command in this shell" },
    });
    launchBtn.addEventListener("click", (evt) => this.openLaunchMenu(evt));

    const newBtn = toolbar.createEl("button", {
      text: "New",
      cls: "gtfo-terminal-btn",
      attr: { title: "Restart the shell" },
    });
    newBtn.addEventListener("click", () => this.restartShell());

    const killBtn = toolbar.createEl("button", {
      text: "Kill",
      cls: "gtfo-terminal-btn",
      attr: { title: "Send SIGTERM to the running process" },
    });
    killBtn.addEventListener("click", () => this.plugin.terminalManager.kill());

    const clearBtn = toolbar.createEl("button", {
      text: "Clear",
      cls: "gtfo-terminal-btn",
      attr: { title: "Clear screen and scrollback" },
    });
    clearBtn.addEventListener("click", () => {
      this.terminal?.clear();
      this.plugin.terminalManager.clearScrollback();
    });

    this.terminalEl = wrapper.createDiv({ cls: "gtfo-terminal" });

    // Don't init the terminal yet. The container is inside a `display: none`
    // tab panel right now (we're rendering both tabs eagerly so chat history
    // survives switches), and xterm.js measures cell sizes from the live DOM
    // — measuring inside a hidden element returns zeros and produces a
    // garbage grid. Defer the heavy work to onShow(), which fires the first
    // time the user actually clicks the Terminal tab.
  }

  /**
   * Initialize xterm + fit-addon and spawn the shell. Safe to call
   * multiple times — the second+ calls are no-ops because `initStarted`
   * latches on the first attempt.
   */
  private async initTerminal(el: HTMLElement): Promise<void> {
    if (this.initStarted) return;
    this.initStarted = true;

    try {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");

      const cssVar = (name: string, fallback: string): string => {
        const v = getComputedStyle(document.body).getPropertyValue(name).trim();
        return v || fallback;
      };

      // Prefer Obsidian's own monospace stack so the terminal blends in
      // with the rest of the UI (and respects the user's font choices in
      // Appearance settings). Falls back to a sane system stack.
      const fontFamily = cssVar(
        "--font-monospace",
        "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, 'Courier New', monospace",
      );

      this.terminal = new Terminal({
        fontSize: this.plugin.settings.terminalFontSize,
        fontFamily,
        cursorBlink: true,
        cursorStyle: "block",
        scrollback: 10000,
        convertEol: false,
        // Let scroll-on-output stay on so program output keeps the
        // viewport pinned to the cursor — feels right for an interactive
        // shell and prevents claude/vim/etc. from "appearing" off-screen
        // when their TUI redraws.
        scrollOnUserInput: true,
        smoothScrollDuration: 0,
        theme: {
          background: cssVar("--background-primary", "#1e1e1e"),
          foreground: cssVar("--text-normal", "#dcdcdc"),
          cursor: cssVar("--text-accent", "#ffffff"),
          cursorAccent: cssVar("--background-primary", "#1e1e1e"),
          selectionBackground: cssVar(
            "--background-modifier-border-hover",
            "#3a3a3a",
          ),
        },
        allowProposedApi: true,
      }) as unknown as XTermTerminal;

      this.fitAddon = new FitAddon() as unknown as FitAddon;
      (this.terminal as unknown as { loadAddon: (a: unknown) => void }).loadAddon(this.fitAddon);

      this.terminal.open(el);

      // Two RAFs of slack so xterm's char-measure element gets to the
      // browser, fonts settle, and our flex layout reaches steady state.
      // fit() reads cell width/height from the live DOM, so without this
      // we sometimes computed cols/rows from pre-paint dimensions and the
      // shell got the wrong size on first prompt.
      await this.waitForLayout(el);
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      try {
        this.fitAddon.fit();
      } catch (e) {
        console.error("[GTFO] initial fit failed:", e);
      }

      let resizeTimer: number | null = null;
      this.resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          if (this.fitAddon && this.terminal) {
            try {
              this.fitAddon.fit();
            } catch {
              // dimensions may be transiently zero (e.g. mid tab switch)
            }
          }
        }, 100);
      });
      this.resizeObserver.observe(el);

      this.wireUpTerminal();

      if (!this.plugin.terminalManager.isRunning) {
        this.spawnShell();
      } else {
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

  /**
   * Parse `terminalLaunchPresets` (newline-separated `Label = command`
   * entries) into a structured list. Lines without `=` use the whole
   * line as both label and command; lines starting with `#` are ignored.
   */
  private parseLaunchPresets(): TerminalLaunchPreset[] {
    const raw = this.plugin.settings.terminalLaunchPresets ?? "";
    const out: TerminalLaunchPreset[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        const label = trimmed.slice(0, eq).trim();
        const command = trimmed.slice(eq + 1).trim();
        if (label && command) out.push({ label, command });
      } else {
        out.push({ label: trimmed, command: trimmed });
      }
    }
    return out;
  }

  private openLaunchMenu(evt: MouseEvent): void {
    const presets = this.parseLaunchPresets();
    const menu = new Menu();

    if (presets.length === 0) {
      menu.addItem((item) =>
        item
          .setTitle("No launch presets configured")
          .setDisabled(true),
      );
    } else {
      for (const preset of presets) {
        menu.addItem((item) =>
          item
            .setTitle(preset.label)
            .onClick(() => this.runCommand(preset.command)),
        );
      }
    }

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Edit presets in settings…")
        .onClick(() => {
          // Best-effort: open the plugin settings tab. Falls back to a notice.
          const settingApi = (
            this.plugin.app as unknown as {
              setting?: { open?: () => void; openTabById?: (id: string) => void };
            }
          ).setting;
          try {
            settingApi?.open?.();
            settingApi?.openTabById?.(this.plugin.manifest.id);
          } catch {
            new Notice("Open Settings → GTFO → Terminal to edit presets");
          }
        }),
    );

    menu.showAtMouseEvent(evt);
  }

  /**
   * Send a command to the running shell, ending with CR so the shell
   * runs it. If no shell is running yet, spawn one first.
   */
  private async runCommand(command: string): Promise<void> {
    if (!this.plugin.terminalManager.isRunning) {
      this.spawnShell();
      // Give the shell a moment to print its first prompt
      await new Promise((r) => setTimeout(r, 250));
    }
    this.plugin.terminalManager.write(`${command}\r`);
    this.terminal?.focus();
  }

  onShow(): void {
    // First time we're actually visible: kick off init now (we deferred
    // it from render() so xterm could measure against a non-hidden DOM).
    if (!this.initStarted && this.terminalEl) {
      void this.initTerminal(this.terminalEl);
      return;
    }

    // Already initialized — re-fit because the container may have been
    // display:none while we were on another tab, which can change the
    // available width/height.
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
    this.initStarted = false;
  }
}

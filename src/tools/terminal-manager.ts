import { type ChildProcess, spawn } from "child_process";
import { createRequire } from "module";
import type { GtfoSettings } from "../types";

type IPty = {
  onData: (callback: (data: string) => void) => { dispose: () => void };
  onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  pid: number;
};

type NodePtyModule = {
  spawn: (
    shell: string,
    args: string[],
    options: Record<string, unknown>,
  ) => IPty;
};

const MAX_BUFFER_BYTES = 200_000; // ~200KB scrollback buffer

export class TerminalManager {
  private pty: IPty | null = null;
  private fallbackProc: ChildProcess | null = null;
  private nodePty: NodePtyModule | null = null;
  private nodePtyAvailable: boolean | null = null;
  private nodePtyLoadError: string | null = null;
  private pluginDir: string | null = null;
  private dataCallbacks: ((data: string) => void)[] = [];
  private exitCallbacks: ((code: number) => void)[] = [];
  private scrollback = "";
  private lastCols = 0;
  private lastRows = 0;

  // Debug state
  private debugMode = false;
  private debugLogPath: string | null = null;
  private debugAppend: ((line: string) => void) | null = null;

  setPluginDir(dir: string): void {
    this.pluginDir = dir;
  }

  setDebug(
    enabled: boolean,
    appender?: (line: string) => void,
    logPath?: string,
  ): void {
    this.debugMode = enabled;
    this.debugAppend = appender ?? null;
    this.debugLogPath = logPath ?? null;
  }

  get isRunning(): boolean {
    return this.pty !== null || this.fallbackProc !== null;
  }

  get pid(): number | null {
    return this.pty?.pid ?? this.fallbackProc?.pid ?? null;
  }

  get usingPty(): boolean {
    return this.pty !== null;
  }

  private tryLoadNodePty(): NodePtyModule | null {
    if (this.nodePtyAvailable === false) return null;
    if (this.nodePty) return this.nodePty;

    const attempts: { label: string; loader: () => NodePtyModule }[] = [];

    if (this.pluginDir) {
      const absPath = require("path").join(this.pluginDir, "node_modules", "node-pty");
      attempts.push({
        label: `absolute path (${absPath})`,
        loader: () => require(absPath) as NodePtyModule,
      });

      attempts.push({
        label: "createRequire from plugin dir",
        loader: () => {
          const pluginRequire = createRequire(
            require("path").join(this.pluginDir!, "main.js"),
          );
          return pluginRequire("node-pty") as NodePtyModule;
        },
      });
    }

    attempts.push({
      label: "bare require('node-pty')",
      loader: () => require("node-pty") as NodePtyModule,
    });

    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        this.nodePty = attempt.loader();
        this.nodePtyAvailable = true;
        console.log(`[GTFO] node-pty loaded via: ${attempt.label}`);
        return this.nodePty;
      } catch (e) {
        errors.push(`${attempt.label}: ${e}`);
      }
    }

    console.error("[GTFO] node-pty failed to load. Tried:", errors.join("\n  "));
    this.nodePtyLoadError = errors.join(" | ");
    this.nodePtyAvailable = false;
    return null;
  }

  spawn(
    settings: GtfoSettings,
    cwd: string,
    cols = 80,
    rows = 24,
  ): void {
    this.kill();
    this.scrollback = "";

    const ptyModule = this.tryLoadNodePty();

    // Cache the initial size so future resize() calls don't no-op
    this.lastCols = cols;
    this.lastRows = rows;

    this.logDebug(
      `\n=== shell spawn @ ${new Date().toISOString()} ===\n` +
        `shell: ${settings.terminalShell}\n` +
        `args:  ${JSON.stringify(parseShellArgs(settings))}\n` +
        `cwd:   ${cwd}\n` +
        `size:  ${cols}x${rows}\n` +
        `transport: ${ptyModule ? "node-pty" : "child_process"}\n`,
    );

    if (ptyModule) {
      this.spawnPty(ptyModule, settings, cwd, cols, rows);
    } else {
      this.spawnFallback(settings, cwd);
    }
  }

  private spawnPty(
    ptyModule: NodePtyModule,
    settings: GtfoSettings,
    cwd: string,
    cols: number,
    rows: number,
  ): void {
    const args = parseShellArgs(settings);

    this.pty = ptyModule.spawn(settings.terminalShell, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: process.env.LANG || "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
        GTFO_TERMINAL: "1",
      },
    });

    this.pty.onData((data: string) => {
      this.logDebug(`out: ${JSON.stringify(data)}\n`);
      this.emitData(data);
    });

    this.pty.onExit((e: { exitCode: number }) => {
      this.logDebug(`exit: code=${e.exitCode}\n`);
      for (const cb of this.exitCallbacks) cb(e.exitCode);
      this.pty = null;
    });
  }

  private spawnFallback(settings: GtfoSettings, cwd: string): void {
    this.emitData(
      "\x1b[33m[GTFO] node-pty not available -- using basic shell.\r\n" +
      "Interactive programs (vim, etc.) won't work. Run 'npm run rebuild-native' for full PTY.\r\n" +
      `Error: ${this.nodePtyLoadError || "unknown"}\x1b[0m\r\n\r\n`,
    );

    const args = parseShellArgs(settings);
    const proc = spawn(settings.terminalShell, args.length ? args : ["-i"], {
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.fallbackProc = proc;

    proc.stdout?.on("data", (data: Buffer) => {
      this.emitData(data.toString());
    });

    proc.stderr?.on("data", (data: Buffer) => {
      this.emitData(data.toString());
    });

    proc.on("exit", (code) => {
      for (const cb of this.exitCallbacks) cb(code ?? 0);
      this.fallbackProc = null;
    });

    proc.on("error", (err) => {
      this.emitData(`\r\n\x1b[31mShell error: ${err.message}\x1b[0m\r\n`);
    });
  }

  write(data: string): void {
    this.logDebug(`in:  ${JSON.stringify(data)}\n`);
    if (this.pty) {
      this.pty.write(data);
    } else if (this.fallbackProc?.stdin?.writable) {
      this.fallbackProc.stdin.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (!cols || !rows) return;
    if (cols === this.lastCols && rows === this.lastRows) return;
    this.lastCols = cols;
    this.lastRows = rows;
    this.logDebug(`resize: ${cols}x${rows}\n`);
    this.pty?.resize(cols, rows);
  }

  kill(): void {
    if (this.pty) {
      this.pty.kill();
      this.pty = null;
    }
    if (this.fallbackProc) {
      this.fallbackProc.kill();
      this.fallbackProc = null;
    }
    this.lastCols = 0;
    this.lastRows = 0;
  }

  clearScrollback(): void {
    this.scrollback = "";
  }

  onData(callback: (data: string) => void): () => void {
    this.dataCallbacks.push(callback);
    if (this.scrollback) callback(this.scrollback);
    return () => {
      this.dataCallbacks = this.dataCallbacks.filter((cb) => cb !== callback);
    };
  }

  onExit(callback: (code: number) => void): () => void {
    this.exitCallbacks.push(callback);
    return () => {
      this.exitCallbacks = this.exitCallbacks.filter((cb) => cb !== callback);
    };
  }

  dispose(): void {
    this.kill();
    this.dataCallbacks = [];
    this.exitCallbacks = [];
  }

  private emitData(data: string): void {
    this.scrollback += data;
    if (this.scrollback.length > MAX_BUFFER_BYTES) {
      this.scrollback = this.scrollback.slice(-MAX_BUFFER_BYTES);
    }
    for (const cb of this.dataCallbacks) cb(data);
  }

  private logDebug(line: string): void {
    if (!this.debugMode || !this.debugAppend) return;
    try {
      this.debugAppend(line);
    } catch {
      // swallow
    }
  }

  get debugPath(): string | null {
    return this.debugLogPath;
  }
}

/**
 * Parse shell args from the settings string. Supports quoted segments.
 */
function parseShellArgs(settings: GtfoSettings): string[] {
  const raw = (settings.terminalShellArgs || "").trim();
  if (!raw) return [];
  // Simple tokenizer supporting single and double quoted strings
  const tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

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

export class TerminalManager {
  private pty: IPty | null = null;
  private fallbackProc: ChildProcess | null = null;
  private nodePty: NodePtyModule | null = null;
  private nodePtyAvailable: boolean | null = null;
  private nodePtyLoadError: string | null = null;
  private pluginDir: string | null = null;
  private dataCallbacks: ((data: string) => void)[] = [];
  private exitCallbacks: ((code: number) => void)[] = [];

  setPluginDir(dir: string): void {
    this.pluginDir = dir;
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

  spawn(settings: GtfoSettings, cwd: string): void {
    this.kill();

    const ptyModule = this.tryLoadNodePty();

    if (ptyModule) {
      this.spawnPty(ptyModule, settings, cwd);
    } else {
      this.spawnFallback(settings, cwd);
    }
  }

  private spawnPty(ptyModule: NodePtyModule, settings: GtfoSettings, cwd: string): void {
    this.pty = ptyModule.spawn(settings.terminalShell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });

    this.pty.onData((data: string) => {
      for (const cb of this.dataCallbacks) cb(data);
    });

    this.pty.onExit((e: { exitCode: number }) => {
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

    const proc = spawn(settings.terminalShell, ["-i"], {
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
    if (this.pty) {
      this.pty.write(data);
    } else if (this.fallbackProc?.stdin?.writable) {
      this.fallbackProc.stdin.write(data);
    }
  }

  resize(cols: number, rows: number): void {
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
  }

  onData(callback: (data: string) => void): () => void {
    this.dataCallbacks.push(callback);
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
    for (const cb of this.dataCallbacks) cb(data);
  }
}

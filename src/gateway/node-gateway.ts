import * as https from "https";
import * as http from "http";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { spawn, exec, type ChildProcess } from "child_process";
import type {
  GatewayOptions,
  HttpRequest,
  HttpResponse,
  ProcessHandle,
} from "./types";

/**
 * NodeGateway centralizes all Node.js-side operations.
 * UI components should never use Node APIs directly -- they route through here.
 *
 * This keeps the browser/Node boundary clean and makes it trivial to:
 * - Bypass CORS for HTTP requests
 * - Spawn processes without importing child_process everywhere
 * - Access the filesystem outside the Obsidian vault
 * - Add logging, rate limiting, or caching in one place
 */
export class NodeGateway {
  private defaultTimeout: number;

  constructor(options?: GatewayOptions) {
    this.defaultTimeout = options?.defaultTimeout ?? 30000;
  }

  // ---------------------------------------------------------------------------
  // HTTP -- CORS-free requests via Node.js http/https
  // ---------------------------------------------------------------------------

  async http(req: HttpRequest): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(req.url);
      const mod = url.protocol === "https:" ? https : http;
      const timeout = req.timeout ?? this.defaultTimeout;

      const options: https.RequestOptions = {
        method: req.method || "GET",
        headers: req.headers || {},
        timeout,
      };

      if (req.signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }

      const nodeReq = mod.request(url, options, (res) => {
        const status = res.statusCode || 200;
        const statusText = res.statusMessage || "";

        const responseHeaders: Record<string, string> = {};
        for (const [key, val] of Object.entries(res.headers)) {
          if (val) {
            responseHeaders[key] = Array.isArray(val) ? val.join(", ") : val;
          }
        }

        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on("data", (chunk: Buffer) =>
              controller.enqueue(new Uint8Array(chunk)),
            );
            res.on("end", () => controller.close());
            res.on("error", (err) => controller.error(err));
          },
          cancel() {
            res.destroy();
          },
        });

        const response: HttpResponse = {
          status,
          statusText,
          headers: responseHeaders,
          body,
          async text() {
            const reader = body.getReader();
            const chunks: Uint8Array[] = [];
            let done = false;
            while (!done) {
              const result = await reader.read();
              done = result.done;
              if (result.value) chunks.push(result.value);
            }
            const combined = new Uint8Array(
              chunks.reduce((a, c) => a + c.length, 0),
            );
            let offset = 0;
            for (const chunk of chunks) {
              combined.set(chunk, offset);
              offset += chunk.length;
            }
            return new TextDecoder().decode(combined);
          },
          async json() {
            return JSON.parse(await response.text());
          },
        };

        resolve(response);
      });

      nodeReq.on("error", (err) => {
        reject(new TypeError(`Network request failed: ${err.message}`));
      });

      nodeReq.on("timeout", () => {
        nodeReq.destroy();
        reject(new TypeError("Request timed out"));
      });

      if (req.signal) {
        const onAbort = () => {
          nodeReq.destroy();
          reject(new DOMException("Aborted", "AbortError"));
        };
        req.signal.addEventListener("abort", onAbort, { once: true });
        nodeReq.on("close", () =>
          req.signal!.removeEventListener("abort", onAbort),
        );
      }

      if (req.body != null) {
        if (typeof req.body === "string") {
          nodeReq.write(req.body);
        } else {
          nodeReq.write(Buffer.from(req.body));
        }
      }

      nodeReq.end();
    });
  }

  /**
   * fetch-compatible wrapper for libraries that expect the Fetch API
   * (e.g., MCP SDK's StreamableHTTPClientTransport).
   */
  asFetch(): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    return async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        input instanceof Request
          ? input.url
          : input.toString();

      const method =
        init?.method ||
        (input instanceof Request ? input.method : "GET");

      const headers: Record<string, string> = {};
      const src =
        init?.headers ||
        (input instanceof Request ? input.headers : undefined);
      if (src) {
        if (src instanceof Headers) {
          src.forEach((v, k) => { headers[k] = v; });
        } else if (Array.isArray(src)) {
          for (const [k, v] of src) headers[k] = v;
        } else {
          Object.assign(headers, src);
        }
      }

      let body: string | Uint8Array | undefined;
      if (init?.body != null) {
        if (typeof init.body === "string") {
          body = init.body;
        } else if (init.body instanceof URLSearchParams) {
          body = init.body.toString();
          if (!headers["content-type"]) {
            headers["content-type"] = "application/x-www-form-urlencoded";
          }
        } else if (init.body instanceof ArrayBuffer) {
          body = new Uint8Array(init.body);
        } else if (init.body instanceof Uint8Array) {
          body = init.body;
        } else if (typeof init.body === "object" && init.body !== null) {
          // FormData, ReadableStream, or other object -- try toString
          body = String(init.body);
        }
      }

      const resp = await this.http({
        url,
        method,
        headers,
        body,
        signal: init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined,
      });

      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
    };
  }

  // ---------------------------------------------------------------------------
  // Process -- spawn and manage child processes
  // ---------------------------------------------------------------------------

  spawnProcess(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): ProcessHandle {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const dataCallbacks: ((data: string) => void)[] = [];
    const exitCallbacks: ((code: number) => void)[] = [];

    proc.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      for (const cb of dataCallbacks) cb(s);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      for (const cb of dataCallbacks) cb(s);
    });
    proc.on("exit", (code) => {
      for (const cb of exitCallbacks) cb(code ?? 1);
    });

    return {
      pid: proc.pid!,
      write(data: string) {
        proc.stdin?.write(data);
      },
      resize() {
        // no-op for basic spawn, PTY handled separately
      },
      kill(signal?: string) {
        proc.kill((signal as NodeJS.Signals) || "SIGTERM");
      },
      onData(cb) {
        dataCallbacks.push(cb);
        return () => {
          const idx = dataCallbacks.indexOf(cb);
          if (idx >= 0) dataCallbacks.splice(idx, 1);
        };
      },
      onExit(cb) {
        exitCallbacks.push(cb);
        return () => {
          const idx = exitCallbacks.indexOf(cb);
          if (idx >= 0) exitCallbacks.splice(idx, 1);
        };
      },
    };
  }

  /**
   * Run a command and return its output. Simple one-shot execution.
   */
  async exec(command: string, options?: { cwd?: string; timeout?: number }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    return new Promise((resolve, reject) => {
      exec(
        command,
        {
          cwd: options?.cwd,
          timeout: options?.timeout ?? this.defaultTimeout,
          env: process.env,
        },
        (error, stdout, stderr) => {
          resolve({
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
            exitCode: error?.code ?? 0,
          });
        },
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Filesystem -- direct Node.js fs access (outside Obsidian vault API)
  // ---------------------------------------------------------------------------

  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, "utf-8");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
  }

  async readBinaryFile(filePath: string): Promise<Buffer> {
    return fs.readFile(filePath);
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async listDir(dirPath: string): Promise<string[]> {
    return fs.readdir(dirPath);
  }

  async stat(filePath: string): Promise<{ size: number; mtime: Date; isDirectory: boolean }> {
    const s = await fs.stat(filePath);
    return { size: s.size, mtime: s.mtime, isDirectory: s.isDirectory() };
  }

  // ---------------------------------------------------------------------------
  // Environment
  // ---------------------------------------------------------------------------

  getEnv(key: string): string | undefined {
    return process.env[key];
  }

  getPlatform(): string {
    return process.platform;
  }

  getHomedir(): string {
    return require("os").homedir();
  }

  resolvePath(...segments: string[]): string {
    return path.resolve(...segments);
  }

  joinPath(...segments: string[]): string {
    return path.join(...segments);
  }
}

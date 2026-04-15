# Node Gateway

The `NodeGateway` class (`src/gateway/node-gateway.ts`) centralizes all Node.js operations. UI components and the MCP client never import Node builtins directly — they route through the gateway.

## Why

Obsidian runs in Electron, which provides both browser APIs and Node.js APIs. Without a clear boundary:

- Browser `fetch()` enforces CORS, blocking Glean MCP requests
- `child_process`, `fs`, `http` imports scatter across the codebase
- Adding logging, caching, or rate limiting requires touching every callsite

The gateway solves this by providing a single interface for all Node-side operations.

## API

### HTTP

```typescript
// Direct request — returns a streaming HttpResponse
const resp = await gateway.http({
  url: "https://api.example.com/data",
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ key: "value" }),
  timeout: 10000,
  signal: abortController.signal,
});

const text = await resp.text();
const json = await resp.json();
// resp.body is a ReadableStream<Uint8Array> for streaming
```

```typescript
// fetch-compatible wrapper — for libraries expecting the Fetch API
const fetchFn = gateway.asFetch();
// Used by MCP SDK's StreamableHTTPClientTransport
```

The `asFetch()` wrapper handles all `RequestInit.body` types: `string`, `URLSearchParams` (form-encoded), `ArrayBuffer`, `Uint8Array`.

### Process Management

```typescript
// One-shot command execution
const { stdout, stderr, exitCode } = await gateway.exec("ls -la", {
  cwd: "/some/path",
  timeout: 5000,
});

// Long-running process with I/O
const proc = gateway.spawnProcess("python", ["script.py"], {
  cwd: "/project",
  env: { PYTHONPATH: "/custom" },
});

proc.onData((output) => console.log(output));
proc.onExit((code) => console.log("exited", code));
proc.write("input data\n");
proc.kill();
```

### Filesystem

```typescript
const content = await gateway.readFile("/absolute/path/to/file.txt");
await gateway.writeFile("/path/to/output.txt", "content");
const exists = await gateway.fileExists("/some/path");
const files = await gateway.listDir("/some/directory");
const info = await gateway.stat("/some/file");
// info = { size: number, mtime: Date, isDirectory: boolean }
```

### Environment

```typescript
gateway.getEnv("HOME");        // → "/Users/patrick"
gateway.getPlatform();          // → "darwin"
gateway.getHomedir();           // → "/Users/patrick"
gateway.resolvePath("~", "docs"); // → "/Users/patrick/docs"
gateway.joinPath("a", "b", "c");  // → "a/b/c"
```

## Usage in the Plugin

The gateway is created once in `main.ts` and shared:

```typescript
export default class GtfoPlugin extends Plugin {
  gateway: NodeGateway = new NodeGateway();

  async onload() {
    // MCP client uses gateway for CORS-free fetch
    await this.mcpClient.connect({
      gateway: this.gateway,
      // ...
    });
  }
}
```

Tool registry tools use the gateway for shell and filesystem operations:

```typescript
this.toolRegistry.register({
  name: "run_command",
  execute: async (args) => {
    return this.gateway.exec(args.command as string);
  },
});
```

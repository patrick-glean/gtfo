# OAuth Flow

GTFO authenticates with Glean's MCP server using OAuth 2.1 with PKCE (Proof Key for Code Exchange). This is the recommended auth method for MCP connections.

## Flow Diagram

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Obsidian   │     │    Glean     │     │     SSO      │
│   Plugin     │     │  OAuth Server│     │   Provider   │
└──────┬──────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                     │
  1.   │── connect() ──────▶│                     │
       │                    │                     │
  2.   │◀── 401 Unauth ────│                     │
       │                    │                     │
  3.   │── discover ───────▶│                     │
       │◀── endpoints ─────│                     │
       │                    │                     │
  4.   │ generate PKCE      │                     │
       │ (code_verifier +   │                     │
       │  code_challenge)   │                     │
       │                    │                     │
  5.   │── open browser ───▶│── redirect ────────▶│
       │                    │                     │
  6.   │                    │◀── SSO auth ────────│
       │                    │                     │
  7.   │◀── redirect to ───│                     │
       │  obsidian://gtfo/  │                     │
       │  oauth-callback    │                     │
       │  ?code=XXX         │                     │
       │                    │                     │
  8.   │── exchange code ──▶│                     │
       │   + code_verifier  │                     │
       │   (URLSearchParams │                     │
       │    body via        │                     │
       │    NodeGateway)    │                     │
       │                    │                     │
  9.   │◀── access_token ──│                     │
       │    refresh_token   │                     │
       │                    │                     │
 10.   │── reconnect with ─▶│                     │
       │   Bearer token     │                     │
       │                    │                     │
 11.   │◀── connected ─────│                     │
       │                    │                     │
```

## Implementation

### OAuthClientProvider (`src/mcp/oauth-provider.ts`)

Implements the MCP SDK's `OAuthClientProvider` interface:

| Method | What it does |
|--------|-------------|
| `clientInformation()` | Returns stored OAuth client registration |
| `saveClientInformation()` | Persists client info via plugin data |
| `tokens()` | Returns stored access/refresh tokens |
| `saveTokens()` | Persists tokens via plugin data |
| `redirectToAuthorization()` | Opens system browser to Glean OAuth URL |
| `codeVerifier()` | Returns stored PKCE code verifier |
| `saveCodeVerifier()` | Persists PKCE verifier via plugin data |

### Protocol Handler (`src/main.ts`)

Obsidian's `registerObsidianProtocolHandler` catches the OAuth redirect:

```
obsidian://gtfo/oauth-callback?code=XXX
```

The handler:
1. Calls `transport.finishAuth(code)` to complete the token exchange
2. Calls `connectToGlean()` to establish the MCP connection with the new tokens
3. Refreshes the sidebar view so Chat tab picks up the connected state

### Token Storage

Tokens are stored in Obsidian's plugin data (`this.saveData()`), which persists across sessions:

- `oauthTokens` — access token, refresh token, expiry
- `oauthClientInfo` — dynamic client registration info
- `oauthCodeVerifier` — PKCE verifier (temporary, used during auth flow)

### Auto-reconnect on startup

On plugin load, `onload()` checks for saved credentials:

```typescript
const canAutoReconnect =
  this.settings.mcpServerUrl &&
  ((this.settings.authMethod === "token" && this.settings.apiToken) ||
    (this.settings.authMethod === "oauth" && this.data.oauthTokens));

if (canAutoReconnect) {
  await this.connectToGlean({ silent: true });
}
```

If tokens are present, it reconnects silently — no Notice, no browser redirect. The MCP SDK's token refresh logic handles expired access tokens using the refresh token.

## API Token Fallback

For testing or when OAuth isn't configured, users can paste a Glean API token in settings. The token is sent as:

```
Authorization: Bearer <token>
X-Glean-Auth-Type: TOKEN
```

Required token scopes: `MCP`, `AGENT`, `SEARCH`, `CHAT`, `DOCUMENTS`, `TOOLS`, `ENTITIES`.

## Troubleshooting

### "POST body can not be empty" during token exchange

The OAuth token exchange sends a `URLSearchParams` body (form-encoded). Browser `fetch` handles this automatically, but custom fetch wrappers must convert it to a string. The `NodeGateway.asFetch()` wrapper handles this — if you see this error, make sure the MCP client is passing the gateway's fetch function, not a bare fetch.

### CORS errors

Browser `fetch()` in Obsidian's renderer process enforces CORS, and Glean's server doesn't whitelist `app://obsidian.md`. The NodeGateway uses Node.js `http`/`https` modules directly which bypass CORS entirely. All MCP calls route through `gateway.asFetch()`.

### OAuth redirect not caught

Ensure:
- The redirect URI is `obsidian://gtfo/oauth-callback` (configured in `ObsidianOAuthProvider.clientMetadata.redirect_uris`)
- `registerObsidianProtocolHandler("gtfo/oauth-callback", ...)` is called in `onload()`
- Your Glean OAuth client has `obsidian://gtfo/oauth-callback` in its allowlisted redirect URIs (your admin may need to add it if using a static client)

### Re-prompted for auth every time

Check `this.data.oauthTokens` after a successful connect — it should be populated. If not:
1. Debug mode won't capture this (connect errors don't go through the chat flow), so check DevTools console
2. Verify `saveTokens` in the OAuthStorage adapter is being called
3. Check that plugin `saveData` is succeeding (some vaults have permissions issues)

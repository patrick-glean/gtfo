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

The handler calls `transport.finishAuth(code)` to complete the token exchange, then `connectToGlean()` to establish the MCP connection with the new tokens.

### Token Storage

Tokens are stored in Obsidian's plugin data (`this.saveData()`), which persists across sessions. The data includes:

- `oauthTokens` — access token, refresh token, expiry
- `oauthClientInfo` — dynamic client registration info
- `oauthCodeVerifier` — PKCE verifier (temporary, used during auth flow)

## API Token Fallback

For testing or when OAuth isn't configured, users can paste a Glean API token in settings. The token is sent as:

```
Authorization: Bearer <token>
X-Glean-Auth-Type: TOKEN
```

Required token scopes: `MCP`, `AGENT`, `SEARCH`, `CHAT`, `DOCUMENTS`, `TOOLS`, `ENTITIES`.

## Troubleshooting

**"OAuth failed: POST body can not be empty"** — The gateway's `asFetch()` wrapper wasn't converting `URLSearchParams` body to string. Fixed in the gateway layer.

**"CORS: No 'Access-Control-Allow-Origin' header"** — The MCP SDK was using browser `fetch()`. Fixed by routing through the Node Gateway which uses Node.js `http`/`https` (no CORS).

**OAuth redirect not caught** — Ensure the redirect URI is `obsidian://gtfo/oauth-callback` (configured in the OAuth provider's `clientMetadata`).

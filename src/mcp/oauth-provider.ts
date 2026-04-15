import { Platform } from "obsidian";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface OAuthStorage {
  loadTokens(): Promise<OAuthTokens | undefined>;
  saveTokens(tokens: OAuthTokens): Promise<void>;
  loadClientInfo(): Promise<OAuthClientInformationFull | undefined>;
  saveClientInfo(info: OAuthClientInformationFull): Promise<void>;
  loadCodeVerifier(): Promise<string | undefined>;
  saveCodeVerifier(verifier: string): Promise<void>;
}

export class ObsidianOAuthProvider implements OAuthClientProvider {
  private storage: OAuthStorage;
  private _redirectUrl: string;
  private _clientMetadata: OAuthClientInformation;

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientInformation {
    return this._clientMetadata;
  }

  constructor(storage: OAuthStorage) {
    this.storage = storage;
    this._redirectUrl = "obsidian://gtfo/oauth-callback";
    this._clientMetadata = {
      redirect_uris: [this._redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      client_name: "Glean Tab For Obsidian",
      client_uri: "https://github.com/your-org/gtfo",
    };
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    return this.storage.loadClientInfo();
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await this.storage.saveClientInfo(info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.storage.loadTokens();
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.storage.saveTokens(tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (Platform.isDesktop) {
      window.open(authorizationUrl.toString());
    }
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.storage.saveCodeVerifier(verifier);
  }

  async codeVerifier(): Promise<string> {
    const verifier = await this.storage.loadCodeVerifier();
    if (!verifier) {
      throw new Error("No code verifier found -- OAuth flow not initiated");
    }
    return verifier;
  }
}

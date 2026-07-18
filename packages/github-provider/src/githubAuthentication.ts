import {
  GitHubTokenMissingError,
  RemoteAuthenticationFailedError,
} from "@local-code-agent/remote-repository";

export type GitHubAuthenticationSource =
  "vscode" | "GITHUB_TOKEN" | "GH_TOKEN" | "credential_store";

export interface GitHubCredentialStore {
  get(): Promise<string | undefined>;
}

export class GitHubAuthentication {
  readonly #memory: { token?: string; source?: GitHubAuthenticationSource } = {};

  public connect(token: string, source: GitHubAuthenticationSource): void {
    const normalized = token.trim();
    if (normalized === "" || /\s/.test(normalized)) {
      throw new RemoteAuthenticationFailedError("Token GitHub ma niepoprawny format.");
    }
    this.#memory.token = normalized;
    this.#memory.source = source;
  }

  public async connectFromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    credentialStore?: GitHubCredentialStore,
  ): Promise<GitHubAuthenticationSource> {
    if (env.GITHUB_TOKEN?.trim()) {
      this.connect(env.GITHUB_TOKEN, "GITHUB_TOKEN");
      return "GITHUB_TOKEN";
    }
    if (env.GH_TOKEN?.trim()) {
      this.connect(env.GH_TOKEN, "GH_TOKEN");
      return "GH_TOKEN";
    }
    const stored = await credentialStore?.get();
    if (stored?.trim()) {
      this.connect(stored, "credential_store");
      return "credential_store";
    }
    throw new GitHubTokenMissingError();
  }

  public getToken(): string {
    if (this.#memory.token === undefined) throw new GitHubTokenMissingError();
    return this.#memory.token;
  }

  public getSource(): GitHubAuthenticationSource | undefined {
    return this.#memory.source;
  }

  public isAuthenticated(): boolean {
    return this.#memory.token !== undefined;
  }

  public disconnect(): void {
    delete this.#memory.token;
    delete this.#memory.source;
  }
}

import { Octokit } from "@octokit/rest";

import {
  GitHubApiError,
  RemoteOperationLimitError,
  RemoteRequestFailedError,
  RemoteRequestTimeoutError,
  safeRemoteMessage,
} from "@local-code-agent/remote-repository";

import type { GitHubApiClient, GitHubApiResponse, GitHubProviderConfig } from "./githubTypes.js";

function validatedBaseUrl(config: GitHubProviderConfig): URL {
  const url = new URL(config.apiBaseUrl);
  if (url.protocol !== "https:") throw new GitHubApiError("GitHub API musi używać HTTPS.");
  if (!config.allowEnterprise && url.origin !== "https://api.github.com") {
    throw new GitHubApiError("Niestandardowy GitHub API jest zablokowany.");
  }
  return url;
}

export class OctokitGitHubClient implements GitHubApiClient {
  private readonly octokit: Octokit;
  private requests = 0;

  public constructor(
    token: string,
    private readonly config: GitHubProviderConfig,
  ) {
    const baseUrl = validatedBaseUrl(config);
    const safeFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, { ...init, redirect: "error" });
      if (new URL(response.url).hostname !== baseUrl.hostname) {
        throw new GitHubApiError("Odpowiedź GitHub przekierowała do innego hosta.");
      }
      return response;
    };
    this.octokit = new Octokit({
      auth: token,
      baseUrl: baseUrl.toString().replace(/\/$/, ""),
      userAgent: "local-code-agent/0.1.0",
      request: { timeout: config.requestTimeoutMs, fetch: safeFetch },
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
  }

  private count(): void {
    this.requests += 1;
    if (this.requests > this.config.maxApiRequestsPerSession) throw new RemoteOperationLimitError();
  }

  public async request<T>(
    route: string,
    parameters: Record<string, unknown> = {},
  ): Promise<GitHubApiResponse<T>> {
    this.count();
    try {
      const response = await this.octokit.request(route, parameters);
      return response as unknown as GitHubApiResponse<T>;
    } catch (error: unknown) {
      throw this.translate(error);
    }
  }

  public async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    this.count();
    try {
      return await this.octokit.graphql<T>(query, variables);
    } catch (error: unknown) {
      throw this.translate(error);
    }
  }

  public getRequestCount(): number {
    return this.requests;
  }

  private translate(error: unknown): Error {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : undefined;
    const message = safeRemoteMessage(
      error instanceof Error ? error.message : "Żądanie GitHub nie powiodło się.",
    );
    if (/timeout|aborted/i.test(message))
      return new RemoteRequestTimeoutError(undefined, { cause: error });
    if (status !== undefined)
      return new GitHubApiError(`GitHub API zwróciło status ${status}.`, { cause: error });
    return new RemoteRequestFailedError(message, { cause: error });
  }
}

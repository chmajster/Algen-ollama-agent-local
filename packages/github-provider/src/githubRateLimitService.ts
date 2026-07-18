import {
  RemoteRateLimitError,
  type GitHubRateLimitState,
} from "@local-code-agent/remote-repository";

import type { GitHubApiClient } from "./githubTypes.js";

interface RateLimitResponse {
  resources: Record<string, { limit: number; remaining: number; reset: number; used: number }>;
  rate: { limit: number; remaining: number; reset: number; used: number };
}

export class GitHubRateLimitService {
  private state: GitHubRateLimitState | undefined;

  public constructor(private readonly client: GitHubApiClient) {}

  public async get(resource = "core"): Promise<GitHubRateLimitState> {
    const { data } = await this.client.request<RateLimitResponse>("GET /rate_limit");
    const value = data.resources[resource] ?? data.rate;
    this.state = {
      limit: value.limit,
      remaining: value.remaining,
      used: value.used,
      resetAt: new Date(value.reset * 1_000).toISOString(),
      resource,
    };
    return { ...this.state };
  }

  public assertAvailable(reserve = 1): void {
    if (this.state !== undefined && this.state.remaining <= reserve) {
      throw new RemoteRateLimitError(`Limit GitHub API jest wyczerpany do ${this.state.resetAt}.`);
    }
  }

  public recommendedDelay(baseDelayMs: number): number {
    if (this.state === undefined || this.state.remaining > Math.max(50, this.state.limit * 0.05))
      return baseDelayMs;
    return Math.max(baseDelayMs, 60_000);
  }
}

import { describe, expect, it } from "vitest";

import { GitHubPermissionService, GitHubRateLimitService } from "../src/index.js";
import type { RepositoryReference } from "@local-code-agent/remote-repository";

import { MockGitHubClient } from "./mockClient.js";

const reference: RepositoryReference = {
  provider: "github",
  host: "github.com",
  owner: "owner",
  repository: "repo",
  remoteName: "origin",
  remoteUrlType: "https",
};

describe("GitHub permissions", () => {
  it.each([
    ["read", { pull: true }, { read: true, canPush: false }],
    ["triage", { pull: true, triage: true }, { triage: true, canComment: true }],
    ["write", { pull: true, push: true }, { write: true, canPush: true }],
    ["maintain", { maintain: true }, { maintain: true, canResolveReviewThreads: true }],
    ["admin", { admin: true }, { admin: true, canPush: true }],
  ])("maps %s", async (_name, permissions, expected) => {
    const client = new MockGitHubClient().on("GET /repos/{owner}/{repo}", { permissions });
    expect(await new GitHubPermissionService(client).get(reference)).toMatchObject(expected);
  });

  it("maps no comment permission", async () => {
    const client = new MockGitHubClient().on("GET /repos/{owner}/{repo}", {
      permissions: { pull: true },
    });
    expect((await new GitHubPermissionService(client).get(reference)).canComment).toBe(false);
  });

  it("reflects changed permissions on a new read", async () => {
    const client = new MockGitHubClient().on(
      "GET /repos/{owner}/{repo}",
      { permissions: { pull: true, push: true } },
      { permissions: { pull: true, push: false } },
    );
    const service = new GitHubPermissionService(client);
    expect((await service.get(reference)).canPush).toBe(true);
    expect((await service.get(reference)).canPush).toBe(false);
  });
});

describe("GitHub rate limit", () => {
  it.each([
    [5_000, 4_999, 1],
    [5_000, 50, 4_950],
    [5_000, 0, 5_000],
  ])("reads limit %i/%i", async (limit, remaining, used) => {
    const client = new MockGitHubClient().on("GET /rate_limit", {
      resources: { core: { limit, remaining, used, reset: 2_000_000_000 } },
      rate: { limit, remaining, used, reset: 2_000_000_000 },
    });
    expect(await new GitHubRateLimitService(client).get()).toMatchObject({
      limit,
      remaining,
      used,
      resource: "core",
    });
  });

  it("backs off polling on a low limit", async () => {
    const client = new MockGitHubClient().on("GET /rate_limit", {
      resources: { core: { limit: 5_000, remaining: 1, used: 4_999, reset: 2_000_000_000 } },
      rate: { limit: 5_000, remaining: 1, used: 4_999, reset: 2_000_000_000 },
    });
    const service = new GitHubRateLimitService(client);
    await service.get();
    expect(service.recommendedDelay(30_000)).toBe(60_000);
    expect(() => service.assertAvailable(1)).toThrow();
  });
});

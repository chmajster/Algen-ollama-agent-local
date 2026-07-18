import { describe, expect, it } from "vitest";

import {
  DEFAULT_GITHUB_CONFIG,
  GitHubActionsLogService,
  GitHubChecksService,
  GitHubPullRequestService,
  GitHubRateLimitService,
} from "../src/index.js";
import {
  RemoteApprovalService,
  type PullRequestReference,
} from "@local-code-agent/remote-repository";

import { MockGitHubClient } from "./mockClient.js";

const repository = {
  provider: "github" as const,
  host: "github.com",
  owner: "owner",
  repository: "repo",
  remoteName: "origin",
  remoteUrlType: "https" as const,
};
const reference: PullRequestReference = { repository, number: 42 };
const pull = {
  number: 42,
  title: "feat: test",
  body: "body",
  html_url: "https://github.com/owner/repo/pull/42",
  state: "open",
  draft: true,
  head: { ref: "agent/task", sha: "a".repeat(40) },
  base: { ref: "main" },
  labels: [],
  created_at: "2026-07-16T00:00:00Z",
  updated_at: "2026-07-16T00:00:00Z",
};

function service(checkRuns: unknown[], statuses: unknown[] = []) {
  const client = new MockGitHubClient()
    .on("GET /repos/{owner}/{repo}/pulls/{pull_number}", pull)
    .on("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { check_runs: checkRuns })
    .on("GET /repos/{owner}/{repo}/commits/{ref}/status", { statuses });
  const pulls = new GitHubPullRequestService(client, new RemoteApprovalService(), {
    ...DEFAULT_GITHUB_CONFIG,
    enabled: true,
  });
  return new GitHubChecksService(
    client,
    new GitHubRateLimitService(client),
    { ...DEFAULT_GITHUB_CONFIG, enabled: true },
    pulls,
  );
}

describe("GitHub checks", () => {
  it.each([
    ["queued", null, "queued", undefined],
    ["in_progress", null, "in_progress", undefined],
    ["completed", "success", "completed", "success"],
    ["completed", "failure", "completed", "failure"],
    ["completed", "skipped", "completed", "skipped"],
  ] as const)("maps %s/%s", async (status, conclusion, expectedStatus, expectedConclusion) => {
    const result = await service([
      {
        id: 1,
        name: "Tests",
        status,
        conclusion,
        head_sha: "a".repeat(40),
        app: { slug: "github-actions" },
      },
    ]).list(reference);
    expect(result[0]).toMatchObject({
      status: expectedStatus,
      ...(expectedConclusion === undefined ? {} : { conclusion: expectedConclusion }),
    });
  });

  it("does not treat no checks as success", async () => {
    expect(await service([]).list(reference)).toEqual([]);
  });

  it("includes external commit status contexts", async () => {
    const result = await service(
      [],
      [{ id: 2, context: "external", state: "failure", created_at: "x", updated_at: "y" }],
    ).list(reference);
    expect(result[0]).toMatchObject({ provider: "external", conclusion: "failure" });
  });

  it("returns once without polling", async () => {
    const checks = service([
      { id: 1, name: "Tests", status: "in_progress", conclusion: null, head_sha: "a".repeat(40) },
    ]);
    expect(await checks.watch(reference, "once")).toHaveLength(1);
  });
});

describe("GitHub Actions logs", () => {
  it("fetches and sanitizes a selected job log", async () => {
    const client = new MockGitHubClient().on(
      "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
      `\u001b[31mERROR\u001b[0m token=${"github_pat_"}${"a".repeat(40)}`,
    );
    const result = await new GitHubActionsLogService(client, {
      ...DEFAULT_GITHUB_CONFIG,
      enabled: true,
    }).get({ ...reference, checkId: "123" });
    expect(result.content).toContain("ERROR");
    expect(result.content).not.toContain("github_pat_");
    expect(result.redactions).toBeGreaterThan(0);
  });

  it("enforces the configured character limit", async () => {
    const client = new MockGitHubClient().on(
      "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
      `ERROR\n${"x".repeat(2_000)}`,
    );
    const result = await new GitHubActionsLogService(client, {
      ...DEFAULT_GITHUB_CONFIG,
      enabled: true,
      maxCiLogChars: 200,
    }).get({ ...reference, checkId: "123" });
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(200);
  });

  it("rejects an invalid check id", async () => {
    await expect(
      new GitHubActionsLogService(new MockGitHubClient(), DEFAULT_GITHUB_CONFIG).get({
        ...reference,
        checkId: "bad",
      }),
    ).rejects.toThrow();
  });
});

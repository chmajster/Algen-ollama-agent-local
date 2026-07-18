import { describe, expect, it } from "vitest";

import {
  DEFAULT_GITHUB_CONFIG,
  GitHubPullRequestService,
  buildPullRequestBody,
  pullRequestMetadataDiff,
  validatePullRequestTitle,
} from "../src/index.js";
import {
  PullRequestAlreadyExistsError,
  PullRequestBodyLimitError,
  PullRequestCreateError,
  RemoteApprovalService,
  type RepositoryReference,
} from "@local-code-agent/remote-repository";

import { MockGitHubClient } from "./mockClient.js";

const repository: RepositoryReference = {
  provider: "github",
  host: "github.com",
  owner: "owner",
  repository: "repo",
  remoteName: "origin",
  remoteUrlType: "https",
};
const pullData = {
  number: 42,
  title: "feat(auth): validate tokens",
  body: "body",
  html_url: "https://github.com/owner/repo/pull/42",
  state: "open" as const,
  draft: true,
  head: { ref: "agent/task", sha: "a".repeat(40) },
  base: { ref: "main" },
  labels: [],
  created_at: "2026-07-16T00:00:00Z",
  updated_at: "2026-07-16T00:00:00Z",
};

function approved(action: "create_pull_request" | "update_pull_request") {
  const approvals = new RemoteApprovalService();
  const request = approvals.request({
    action,
    repository: "github.com/owner/repo",
    summary: action,
  });
  approvals.decide(request.id, "approved", "user_cli");
  return { approvals, id: request.id };
}

function createClient(existing: unknown[] = []) {
  return new MockGitHubClient()
    .on("GET /repos/{owner}/{repo}/git/ref/{ref}", {}, {})
    .on("GET /repos/{owner}/{repo}/pulls", existing)
    .on("POST /repos/{owner}/{repo}/pulls", pullData);
}

describe("Pull Request title and body", () => {
  it("validates a conventional title", () =>
    expect(validatePullRequestTitle("feat(auth): validate tokens")).toBe(
      "feat(auth): validate tokens",
    ));
  it("rejects a title longer than 72 chars", () =>
    expect(() => validatePullRequestTitle("x".repeat(73))).toThrow(PullRequestCreateError));
  it("rejects WIP", () =>
    expect(() => validatePullRequestTitle("WIP add feature")).toThrow(PullRequestCreateError));
  it("rejects token patterns", () =>
    expect(() => validatePullRequestTitle(`fix ${"ghp_"}${"a".repeat(30)}`)).toThrow(
      PullRequestCreateError,
    ));

  it("uses actual verification states", () => {
    const body = buildPullRequestBody({
      goal: "Cel",
      changes: ["Zmiana"],
      changedAreas: ["C:\\Users\\Chris\\project\\src\\a.ts"],
      verification: [{ name: "Tests", status: "failed", details: "1 failed" }],
      risks: ["Ryzyko"],
      taskId: "task-1",
      commits: 2,
      issueNumber: 12,
      issueLinkKeyword: "Closes",
    });
    expect(body).toContain("Tests: failed");
    expect(body).toContain("Closes #12");
    expect(body).not.toContain("C:\\Users\\Chris");
    expect(body).not.toContain("All tests pass");
  });

  it("enforces body limit", () => {
    expect(() =>
      buildPullRequestBody(
        {
          goal: "x".repeat(2_000),
          changes: [],
          changedAreas: [],
          verification: [],
          risks: [],
          taskId: "task-1",
          commits: 1,
        },
        1_000,
      ),
    ).toThrow(PullRequestBodyLimitError);
  });

  it("shows metadata differences", () => {
    expect(
      pullRequestMetadataDiff(
        { title: "old", body: "old", labels: [] },
        { title: "new", labels: ["tests"] },
      ),
    ).toContain("+ title: new");
  });
});

describe("GitHubPullRequestService", () => {
  it("creates a Draft PR after approval", async () => {
    const approval = approved("create_pull_request");
    const service = new GitHubPullRequestService(createClient(), approval.approvals, {
      ...DEFAULT_GITHUB_CONFIG,
      enabled: true,
    });
    const result = await service.create({
      repository,
      taskId: "task-1",
      title: pullData.title,
      body: "body",
      headBranch: "agent/task",
      baseBranch: "main",
      draft: true,
      approvalId: approval.id,
    });
    expect(result).toMatchObject({ number: 42, draft: true });
  });

  it("detects an existing PR", async () => {
    const approval = approved("create_pull_request");
    const service = new GitHubPullRequestService(createClient([pullData]), approval.approvals, {
      ...DEFAULT_GITHUB_CONFIG,
      enabled: true,
    });
    await expect(
      service.create({
        repository,
        taskId: "task-1",
        title: pullData.title,
        body: "body",
        headBranch: "agent/task",
        baseBranch: "main",
        draft: true,
        approvalId: approval.id,
      }),
    ).rejects.toThrow(PullRequestAlreadyExistsError);
  });

  it("rejects equal head and base", async () => {
    const approval = approved("create_pull_request");
    const service = new GitHubPullRequestService(createClient(), approval.approvals, {
      ...DEFAULT_GITHUB_CONFIG,
      enabled: true,
    });
    await expect(
      service.create({
        repository,
        taskId: "task-1",
        title: pullData.title,
        body: "body",
        headBranch: "main",
        baseBranch: "main",
        draft: true,
        approvalId: approval.id,
      }),
    ).rejects.toThrow(PullRequestCreateError);
  });

  it("validates issue existence", async () => {
    const approval = approved("create_pull_request");
    const client = createClient().on("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      number: 12,
    });
    const service = new GitHubPullRequestService(client, approval.approvals, {
      ...DEFAULT_GITHUB_CONFIG,
      enabled: true,
    });
    const result = await service.create({
      repository,
      taskId: "task-1",
      title: pullData.title,
      body: "body",
      headBranch: "agent/task",
      baseBranch: "main",
      draft: true,
      issueNumber: 12,
      approvalId: approval.id,
    });
    expect(result.issueNumber).toBe(12);
  });

  it("validates existing labels", async () => {
    const approval = approved("create_pull_request");
    const client = createClient()
      .on("GET /repos/{owner}/{repo}/labels", [{ name: "tests" }])
      .on("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {});
    const service = new GitHubPullRequestService(client, approval.approvals, {
      ...DEFAULT_GITHUB_CONFIG,
      enabled: true,
    });
    expect(
      (
        await service.create({
          repository,
          taskId: "task-1",
          title: pullData.title,
          body: "body",
          headBranch: "agent/task",
          baseBranch: "main",
          draft: true,
          labels: ["tests"],
          approvalId: approval.id,
        })
      ).labels,
    ).toEqual(["tests"]);
  });

  it("rejects a missing label", async () => {
    const approval = approved("create_pull_request");
    const client = createClient().on("GET /repos/{owner}/{repo}/labels", [{ name: "bug" }]);
    const service = new GitHubPullRequestService(client, approval.approvals, {
      ...DEFAULT_GITHUB_CONFIG,
      enabled: true,
    });
    await expect(
      service.create({
        repository,
        taskId: "task-1",
        title: pullData.title,
        body: "body",
        headBranch: "agent/task",
        baseBranch: "main",
        draft: true,
        labels: ["missing"],
        approvalId: approval.id,
      }),
    ).rejects.toThrow(PullRequestCreateError);
  });
});

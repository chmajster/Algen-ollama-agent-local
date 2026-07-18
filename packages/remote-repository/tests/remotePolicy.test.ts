import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  RemoteApprovalService,
  RemoteAuditService,
  RemoteForcePushBlockedError,
  RemoteOperationPolicy,
  RemotePermissionDeniedError,
  RemotePushApprovalRequiredError,
  RemoteRepositoryRegistry,
  RemoteRepositoryUnverifiedError,
  type RemoteRepositoryProvider,
  type RepositoryPermissions,
} from "../src/index.js";

const permissions: RepositoryPermissions = {
  read: true,
  triage: true,
  write: true,
  maintain: false,
  admin: false,
  canPush: true,
  canCreatePullRequest: true,
  canComment: true,
  canManageIssues: true,
  canResolveReviewThreads: true,
};

describe("remote operation policy", () => {
  const policy = new RemoteOperationPolicy();

  it.each(["read_repository", "read_checks", "read_logs", "read_reviews"] as const)(
    "allows verified %s without approval",
    (action) => {
      expect(policy.evaluate({ action, trust: "verified_for_session", permissions })).toMatchObject(
        { allowed: true, requiresApproval: false },
      );
    },
  );

  it.each([
    "publish_branch",
    "create_pull_request",
    "update_pull_request",
    "reply_review",
    "resolve_thread",
  ] as const)("requires approval for %s", (action) => {
    expect(policy.evaluate({ action, trust: "verified_for_workspace", permissions })).toMatchObject(
      { allowed: true, requiresApproval: true },
    );
  });

  it("blocks unverified repositories", () => {
    expect(() =>
      policy.evaluate({ action: "read_checks", trust: "unverified", permissions }),
    ).toThrow(RemoteRepositoryUnverifiedError);
  });

  it("blocks missing push permission", () => {
    expect(() =>
      policy.evaluate({
        action: "publish_branch",
        trust: "verified_for_session",
        permissions: { ...permissions, canPush: false },
      }),
    ).toThrow(RemotePermissionDeniedError);
  });

  it("blocks force push unconditionally", () => {
    expect(() =>
      policy.evaluate({ action: "force_push", trust: "verified_for_session", permissions }),
    ).toThrow(RemoteForcePushBlockedError);
  });
});

describe("remote approvals", () => {
  it("consumes an approval once", () => {
    const approvals = new RemoteApprovalService();
    const request = approvals.request({
      action: "publish_branch",
      repository: "github.com/o/r",
      summary: "push",
    });
    approvals.decide(request.id, "approved", "user_cli");
    approvals.consume(request.id, "publish_branch", "github.com/o/r");
    expect(() => approvals.consume(request.id, "publish_branch", "github.com/o/r")).toThrow(
      RemotePushApprovalRequiredError,
    );
  });

  it("does not reuse approval for another repository", () => {
    const approvals = new RemoteApprovalService();
    const request = approvals.request({
      action: "publish_branch",
      repository: "github.com/o/r",
      summary: "push",
    });
    approvals.decide(request.id, "approved", "user_ui");
    expect(() => approvals.consume(request.id, "publish_branch", "github.com/x/r")).toThrow(
      RemotePushApprovalRequiredError,
    );
  });

  it("records denial", () => {
    const approvals = new RemoteApprovalService();
    const request = approvals.request({
      action: "create_pull_request",
      repository: "github.com/o/r",
      summary: "pr",
    });
    expect(approvals.decide(request.id, "denied", "user_cli").status).toBe("denied");
  });
});

describe("remote audit and registry", () => {
  it("writes only allowlisted audit metadata without token", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-audit-"));
    const path = join(root, "remote.jsonl");
    await new RemoteAuditService(path).record({
      timestamp: new Date(0).toISOString(),
      sessionId: "session",
      provider: "github",
      repository: "github.com/o/r",
      action: "publish_branch",
      approval: "allowed_once",
      result: "failed",
      errorCode: "Bearer ghp_abcdefghijklmnopqrstuvwxyz123456",
    });
    const content = await readFile(path, "utf8");
    expect(content).not.toContain("ghp_");
    expect(JSON.parse(content)).toMatchObject({ action: "publish_branch", result: "failed" });
  });

  it("registers a provider", () => {
    const registry = new RemoteRepositoryRegistry();
    const provider = { name: "github" } as RemoteRepositoryProvider;
    registry.register(provider);
    expect(registry.get("github")).toBe(provider);
  });
});

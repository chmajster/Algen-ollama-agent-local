import { describe, expect, it } from "vitest";

import {
  JSON_RPC_VERSION,
  PROTOCOL_VERSION,
  ProtocolError,
  assertCompatibleVersion,
  assertSession,
  createErrorResponse,
  createNotification,
  createRequest,
  createResponse,
  envelope,
  notificationNames,
  parseNotification,
  parseRequest,
  parseResponse,
  procedureNames,
  type NotificationName,
  type ProcedureName,
} from "../src/index.js";

const sessionId = "test-session";
const totals = {
  filesChanged: 0,
  filesCreated: 0,
  filesDeleted: 0,
  filesMoved: 0,
  additions: 0,
  deletions: 0,
};
const task = {
  id: "task-1",
  title: "Sprawdź projekt",
  mode: "ask",
  phase: "analysis",
  createdAt: "2026-07-16T00:00:00.000Z",
};
const settings = {
  ollamaHost: "http://127.0.0.1:11434",
  ollamaModel: "qwen3.5:9b",
  maxSteps: 20,
  contextLength: 32_768,
  temperature: 0.1,
  mode: "edit",
  autoStartRuntime: false,
  verificationEnabled: true,
  requireWriteConfirmation: true,
  verifyAfterApply: true,
  verificationScope: "affected_packages",
  commandPolicy: "verification",
  allowNetwork: false,
  allowPackageInstall: false,
  allowFileDelete: false,
  allowFileMove: true,
  rollbackOnVerificationFailure: false,
  maxRepairAttempts: 3,
  respectGitignore: true,
  includeHiddenFiles: false,
  allowSensitiveFiles: false,
  commandsEnabled: true,
  debug: false,
  orchestrationEnabled: true,
  orchestrationDefaultMode: "analysis",
  orchestrationMaxAgents: 8,
  orchestrationMaxParallelAgents: 3,
  orchestrationRequirePlanApproval: true,
  orchestrationRequireFinalApproval: true,
  orchestrationRequireIndependentReview: true,
  orchestrationRequireSecurityReview: true,
  orchestrationShowAgentActivity: true,
  orchestrationShowTaskGraph: true,
  remoteEnabled: false,
  remoteProvider: "github",
  githubAuthenticationMode: "vscode",
  githubApiBaseUrl: "https://api.github.com",
  githubWebBaseUrl: "https://github.com",
  githubAllowEnterprise: false,
  githubCreateDraftPullRequest: true,
  githubRequirePushConfirmation: true,
  githubRequirePullRequestConfirmation: true,
  githubRequireCommentConfirmation: true,
  githubRequireResolveThreadConfirmation: true,
  githubAllowLabelChanges: true,
  githubAllowIssueCreation: false,
  githubAllowIssueClosing: false,
  githubAllowReadyForReview: false,
  githubAllowMerge: false,
  githubAllowBranchDelete: false,
  githubAllowForcePush: false,
  githubCiPollingInterval: 30_000,
  githubCiMaxWait: 1_800_000,
} as const;
const workspace = { activeRoot: null, roots: [], trusted: true, kind: "none" };
const orchestrationSessionId = "00000000-0000-4000-8000-000000000001";

const requestSamples: Record<ProcedureName, unknown> = {
  "runtime.initialize": { clientName: "tests", clientVersion: "1.0.0", workspaceTrusted: true },
  "runtime.shutdown": {},
  "runtime.health": {},
  "runtime.getCapabilities": {},
  "workspace.set": workspace,
  "workspace.getInfo": {},
  "task.start": { task: "Sprawdź projekt", mode: "ask" },
  "task.cancel": { taskId: "task-1" },
  "task.get": { taskId: "task-1" },
  "task.list": {},
  "agent.sendMessage": { message: "Kontynuuj", mode: "ask" },
  "agent.getState": {},
  "changes.getCurrent": {},
  "changes.preview": {},
  "changes.apply": {},
  "changes.reject": {},
  "verification.run": {},
  "verification.get": {},
  "checkpoints.list": {},
  "checkpoints.restore": { checkpointId: "checkpoint-1" },
  "settings.update": {},
  "settings.get": {},
  "remote.getStatus": {},
  "remote.authenticate": { mode: "vscode", token: "test-token" },
  "remote.disconnect": {},
  "remote.getRepository": {},
  "remote.verifyRepository": {},
  "remote.getPermissions": {},
  "remote.getRateLimit": {},
  "remote.publishTaskBranch": { taskId: "task-1" },
  "remote.getPublishedBranch": { taskId: "task-1" },
  "pullRequest.createDraft": { taskId: "task-1" },
  "pullRequest.get": { taskId: "task-1" },
  "pullRequest.update": { taskId: "task-1", title: "feat: update" },
  "pullRequest.openInBrowser": { taskId: "task-1" },
  "pullRequest.listChecks": { taskId: "task-1" },
  "pullRequest.watchChecks": { taskId: "task-1", mode: "once" },
  "pullRequest.cancelWatch": {},
  "pullRequest.getCheckLogs": { taskId: "task-1", checkId: "1" },
  "pullRequest.analyzeCheck": { taskId: "task-1", checkId: "1" },
  "pullRequest.listReviews": { taskId: "task-1" },
  "pullRequest.listThreads": { taskId: "task-1" },
  "pullRequest.getThread": { taskId: "task-1", threadId: "thread-1" },
  "pullRequest.replyToThread": {
    taskId: "task-1",
    threadId: "thread-1",
    body: "Poprawiono w commicie abc1234.",
    commitSha: "abc1234",
  },
  "pullRequest.resolveThread": { taskId: "task-1", threadId: "thread-1" },
  "pullRequest.linkIssue": { taskId: "task-1", issueNumber: 1, keyword: "Refs" },
  "pullRequest.setLabels": { taskId: "task-1", labels: ["tests"] },
  "orchestration.getStatus": {},
  "orchestration.create": { task: "Analyze architecture", mode: "analysis" },
  "orchestration.get": { sessionId: orchestrationSessionId },
  "orchestration.list": {},
  "orchestration.cancel": { sessionId: orchestrationSessionId },
  "orchestration.resume": { sessionId: orchestrationSessionId },
  "orchestration.getPlan": { sessionId: orchestrationSessionId },
  "orchestration.approvePlan": { sessionId: orchestrationSessionId },
  "orchestration.rejectPlan": { sessionId: orchestrationSessionId },
  "orchestration.getTaskGraph": { sessionId: orchestrationSessionId },
  "orchestration.getNode": { sessionId: orchestrationSessionId, nodeId: "analysis" },
  "orchestration.retryNode": { sessionId: orchestrationSessionId, nodeId: "analysis" },
  "orchestration.cancelNode": { sessionId: orchestrationSessionId, nodeId: "analysis" },
  "orchestration.getAgents": { sessionId: orchestrationSessionId },
  "orchestration.getAgent": { sessionId: orchestrationSessionId, agentId: "agent-1" },
  "orchestration.getArtifacts": { sessionId: orchestrationSessionId },
  "orchestration.getConflicts": { sessionId: orchestrationSessionId },
  "orchestration.getReview": { sessionId: orchestrationSessionId },
  "orchestration.approveResult": { sessionId: orchestrationSessionId },
  "orchestration.rejectResult": { sessionId: orchestrationSessionId },
};

const verification = {
  id: "verification-1",
  status: "passed",
  startedAt: "2026-07-16T00:00:00.000Z",
  finishedAt: "2026-07-16T00:00:01.000Z",
  durationMs: 1_000,
  scope: "workspace",
  steps: [],
  diagnostics: [],
  regressions: [],
  preExistingIssues: [],
  resolvedIssues: [],
  summary: {},
};
const preview = {
  changeSetId: "changes-1",
  diff: "",
  fileDiffs: {},
  operations: [],
  warnings: [],
  conflicts: [],
  totals,
  canApply: false,
  diffTruncated: false,
};
const changes = {
  changeSetId: "changes-1",
  status: "draft",
  mode: "preview",
  previewAvailable: false,
  operations: [],
  totals,
};

const notificationSamples: Record<NotificationName, unknown> = {
  "runtime.ready": { runtimeVersion: "0.2.0", protocolVersion: PROTOCOL_VERSION },
  "runtime.error": { code: "TEST", message: "Błąd", recoverable: true },
  "task.created": task,
  "task.phaseChanged": { taskId: "task-1", phase: "planning" },
  "task.progress": { taskId: "task-1", message: "Czytam pliki" },
  "task.completed": { ...task, phase: "completed" },
  "task.failed": { ...task, phase: "failed", error: "Błąd" },
  "task.cancelled": { ...task, phase: "cancelled" },
  "agent.message": { taskId: "task-1", role: "assistant", content: "Gotowe" },
  "agent.toolCallStarted": { taskId: "task-1", toolCallId: "call-1", toolName: "read_file" },
  "agent.toolCallCompleted": {
    taskId: "task-1",
    toolCallId: "call-1",
    toolName: "read_file",
    durationMs: 2,
  },
  "agent.toolCallFailed": {
    taskId: "task-1",
    toolCallId: "call-1",
    toolName: "read_file",
    error: "Błąd",
  },
  "changes.updated": { changes },
  "changes.previewReady": preview,
  "changes.applied": { status: "applied" },
  "changes.rejected": {},
  "verification.started": {},
  "verification.stepStarted": { commandId: "test", displayName: "Testy" },
  "verification.stepCompleted": { commandId: "test", status: "passed" },
  "verification.completed": verification,
  "checkpoint.created": { checkpointId: "checkpoint-1" },
  "checkpoint.restored": { checkpointId: "checkpoint-1" },
  "remote.authenticationChanged": { authenticated: true },
  "remote.repositoryVerified": { repository: "owner/repo" },
  "remote.permissionChanged": { canPush: true },
  "remote.rateLimitChanged": { remaining: 4_999 },
  "remote.publishApprovalRequired": { requestId: "approval-1" },
  "remote.branchPublished": { branch: "agent/task" },
  "remote.branchPublishFailed": { code: "REMOTE_PUSH_FAILED" },
  "pullRequest.createApprovalRequired": { requestId: "approval-2" },
  "pullRequest.created": { number: 42 },
  "pullRequest.updated": { number: 42 },
  "pullRequest.checksChanged": { checks: [] },
  "pullRequest.checkStarted": { checkId: "1" },
  "pullRequest.checkCompleted": { checkId: "1" },
  "pullRequest.ciAnalysisReady": { checkId: "1" },
  "pullRequest.reviewThreadsChanged": { threads: [] },
  "pullRequest.reviewReplyApprovalRequired": { requestId: "approval-3" },
  "pullRequest.reviewReplySent": { id: "comment-1" },
  "pullRequest.resolveApprovalRequired": { requestId: "approval-4" },
  "pullRequest.threadResolved": { threadId: "thread-1" },
  "remote.securityWarning": {
    code: "REMOTE_PROMPT_INJECTION_WARNING",
    message: "Untrusted content",
    critical: true,
  },
  "orchestration.created": { sessionId: orchestrationSessionId },
  "orchestration.planReady": { sessionId: orchestrationSessionId },
  "orchestration.planApproved": { sessionId: orchestrationSessionId },
  "orchestration.stateChanged": { sessionId: orchestrationSessionId },
  "orchestration.taskGraphUpdated": { sessionId: orchestrationSessionId },
  "orchestration.nodeStarted": { sessionId: orchestrationSessionId },
  "orchestration.nodeProgress": { sessionId: orchestrationSessionId },
  "orchestration.nodeCompleted": { sessionId: orchestrationSessionId },
  "orchestration.nodeFailed": { sessionId: orchestrationSessionId },
  "orchestration.nodeBlocked": { sessionId: orchestrationSessionId },
  "orchestration.agentStarted": { sessionId: orchestrationSessionId },
  "orchestration.agentCompleted": { sessionId: orchestrationSessionId },
  "orchestration.agentFailed": { sessionId: orchestrationSessionId },
  "orchestration.artifactCreated": { sessionId: orchestrationSessionId },
  "orchestration.conflictDetected": { sessionId: orchestrationSessionId },
  "orchestration.replanStarted": { sessionId: orchestrationSessionId },
  "orchestration.replanCompleted": { sessionId: orchestrationSessionId },
  "orchestration.reviewReady": { sessionId: orchestrationSessionId },
  "orchestration.securityBlocked": { sessionId: orchestrationSessionId },
  "orchestration.approvalRequired": { sessionId: orchestrationSessionId },
  "orchestration.completed": { sessionId: orchestrationSessionId },
  "orchestration.failed": { sessionId: orchestrationSessionId },
  "orchestration.cancelled": { sessionId: orchestrationSessionId },
};

describe("runtime protocol requests", () => {
  it.each(procedureNames)("validates %s", (method) => {
    const parsed = parseRequest({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      method,
      params: envelope(sessionId, requestSamples[method]),
    });
    expect(parsed.method).toBe(method);
  });

  it.each(procedureNames)("rejects an invalid envelope for %s", (method) => {
    expect(() =>
      parseRequest({ jsonrpc: JSON_RPC_VERSION, id: 1, method, params: requestSamples[method] }),
    ).toThrow(ProtocolError);
  });

  it("creates a typed request", () => {
    expect(createRequest(7, "task.start", sessionId, { task: "Test", mode: "plan" })).toMatchObject(
      {
        id: 7,
        method: "task.start",
      },
    );
  });

  it("rejects an unknown method", () => {
    expect(() =>
      parseRequest({
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "bad.method",
        params: envelope(sessionId, {}),
      }),
    ).toThrow(/Nieznana procedura/u);
  });
});

describe("runtime protocol notifications", () => {
  it.each(notificationNames)("validates %s", (method) => {
    const parsed = parseNotification({
      jsonrpc: JSON_RPC_VERSION,
      method,
      params: envelope(sessionId, notificationSamples[method]),
    });
    expect(parsed.method).toBe(method);
  });

  it("creates and validates a notification", () => {
    const message = createNotification("task.progress", sessionId, {
      taskId: "task-1",
      message: "Praca",
    });
    expect(parseNotification(message)).toEqual(message);
  });
});

describe("runtime protocol responses", () => {
  it("creates and validates a success response", () => {
    const value = createResponse(1, "settings.get", sessionId, settings);
    expect(parseResponse("settings.get", value)).toEqual(value);
  });

  it("passes through a JSON-RPC error", () => {
    const value = createErrorResponse(1, -32_603, "Internal error", { code: "TEST" });
    expect(parseResponse("runtime.health", value)).toEqual(value);
  });

  it("rejects a result for a different procedure", () => {
    const value = createResponse(1, "runtime.shutdown", sessionId, { ok: true });
    expect(() => parseResponse("settings.get", value)).toThrow(ProtocolError);
  });
});

describe("protocol compatibility", () => {
  it.each(["1.0.0", "1.2.3", "1.8.0-beta.1"])("accepts compatible %s", (version) => {
    expect(() => assertCompatibleVersion(version)).not.toThrow();
  });

  it.each(["2.0.0", "0.9.0", "latest", ""])("rejects incompatible %s", (version) => {
    expect(() => assertCompatibleVersion(version)).toThrow(/Niezgodna wersja/u);
  });

  it("detects a foreign session", () => {
    expect(() => assertSession(sessionId, "other")).toThrow(/innej sesji/u);
  });

  it("accepts the expected session", () => {
    expect(() => assertSession(sessionId, sessionId)).not.toThrow();
  });
});

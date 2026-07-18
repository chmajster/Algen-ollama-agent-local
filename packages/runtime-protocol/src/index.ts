import { z } from "zod";

export const PROTOCOL_VERSION = "1.2.0" as const;
export const JSON_RPC_VERSION = "2.0" as const;

export const procedureNames = [
  "runtime.initialize",
  "runtime.shutdown",
  "runtime.health",
  "runtime.getCapabilities",
  "workspace.set",
  "workspace.getInfo",
  "task.start",
  "task.cancel",
  "task.get",
  "task.list",
  "agent.sendMessage",
  "agent.getState",
  "changes.getCurrent",
  "changes.preview",
  "changes.apply",
  "changes.reject",
  "verification.run",
  "verification.get",
  "checkpoints.list",
  "checkpoints.restore",
  "settings.update",
  "settings.get",
  "remote.getStatus",
  "remote.authenticate",
  "remote.disconnect",
  "remote.getRepository",
  "remote.verifyRepository",
  "remote.getPermissions",
  "remote.getRateLimit",
  "remote.publishTaskBranch",
  "remote.getPublishedBranch",
  "pullRequest.createDraft",
  "pullRequest.get",
  "pullRequest.update",
  "pullRequest.openInBrowser",
  "pullRequest.listChecks",
  "pullRequest.watchChecks",
  "pullRequest.cancelWatch",
  "pullRequest.getCheckLogs",
  "pullRequest.analyzeCheck",
  "pullRequest.listReviews",
  "pullRequest.listThreads",
  "pullRequest.getThread",
  "pullRequest.replyToThread",
  "pullRequest.resolveThread",
  "pullRequest.linkIssue",
  "pullRequest.setLabels",
  "orchestration.getStatus",
  "orchestration.create",
  "orchestration.get",
  "orchestration.list",
  "orchestration.cancel",
  "orchestration.resume",
  "orchestration.getPlan",
  "orchestration.approvePlan",
  "orchestration.rejectPlan",
  "orchestration.getTaskGraph",
  "orchestration.getNode",
  "orchestration.retryNode",
  "orchestration.cancelNode",
  "orchestration.getAgents",
  "orchestration.getAgent",
  "orchestration.getArtifacts",
  "orchestration.getConflicts",
  "orchestration.getReview",
  "orchestration.approveResult",
  "orchestration.rejectResult",
] as const;

export const notificationNames = [
  "runtime.ready",
  "runtime.error",
  "task.created",
  "task.phaseChanged",
  "task.progress",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "agent.message",
  "agent.toolCallStarted",
  "agent.toolCallCompleted",
  "agent.toolCallFailed",
  "changes.updated",
  "changes.previewReady",
  "changes.applied",
  "changes.rejected",
  "verification.started",
  "verification.stepStarted",
  "verification.stepCompleted",
  "verification.completed",
  "checkpoint.created",
  "checkpoint.restored",
  "remote.authenticationChanged",
  "remote.repositoryVerified",
  "remote.permissionChanged",
  "remote.rateLimitChanged",
  "remote.publishApprovalRequired",
  "remote.branchPublished",
  "remote.branchPublishFailed",
  "pullRequest.createApprovalRequired",
  "pullRequest.created",
  "pullRequest.updated",
  "pullRequest.checksChanged",
  "pullRequest.checkStarted",
  "pullRequest.checkCompleted",
  "pullRequest.ciAnalysisReady",
  "pullRequest.reviewThreadsChanged",
  "pullRequest.reviewReplyApprovalRequired",
  "pullRequest.reviewReplySent",
  "pullRequest.resolveApprovalRequired",
  "pullRequest.threadResolved",
  "remote.securityWarning",
  "orchestration.created",
  "orchestration.planReady",
  "orchestration.planApproved",
  "orchestration.stateChanged",
  "orchestration.taskGraphUpdated",
  "orchestration.nodeStarted",
  "orchestration.nodeProgress",
  "orchestration.nodeCompleted",
  "orchestration.nodeFailed",
  "orchestration.nodeBlocked",
  "orchestration.agentStarted",
  "orchestration.agentCompleted",
  "orchestration.agentFailed",
  "orchestration.artifactCreated",
  "orchestration.conflictDetected",
  "orchestration.replanStarted",
  "orchestration.replanCompleted",
  "orchestration.reviewReady",
  "orchestration.securityBlocked",
  "orchestration.approvalRequired",
  "orchestration.completed",
  "orchestration.failed",
  "orchestration.cancelled",
] as const;

export type ProcedureName = (typeof procedureNames)[number];
export type NotificationName = (typeof notificationNames)[number];
export type JsonRpcId = string | number;

export class ProtocolError extends Error {
  public constructor(
    message: string,
    public readonly code:
      "INVALID_MESSAGE" | "UNKNOWN_METHOD" | "VERSION_MISMATCH" | "SESSION_MISMATCH",
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
const sessionIdSchema = z.string().trim().min(1).max(200);
const jsonRpcIdSchema = z.union([z.string().min(1), z.number().int()]);
const emptySchema = z.object({}).strict();
const stringRecordSchema = z.record(z.string(), z.unknown());

export const agentModeSchema = z.enum(["ask", "plan", "edit", "agent", "orchestrated"]);
export type AgentMode = z.infer<typeof agentModeSchema>;

export const taskPhaseSchema = z.enum([
  "queued",
  "analysis",
  "baseline",
  "planning",
  "orchestration",
  "editing",
  "preview",
  "confirmation",
  "applying",
  "verification",
  "repair",
  "completed",
  "failed",
  "cancelled",
  "rolled_back",
]);
export type TaskPhase = z.infer<typeof taskPhaseSchema>;

export const runtimeStateSchema = z.enum([
  "stopped",
  "starting",
  "ready",
  "busy",
  "restarting",
  "failed",
]);
export type RuntimeState = z.infer<typeof runtimeStateSchema>;

export const diagnosticSchema = z
  .object({
    path: z.string(),
    line: z.number().int().nonnegative().optional(),
    column: z.number().int().nonnegative().optional(),
    endLine: z.number().int().nonnegative().optional(),
    endColumn: z.number().int().nonnegative().optional(),
    severity: z.enum(["error", "warning", "information", "hint"]),
    message: z.string(),
    source: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

export const editorContextSchema = z
  .object({
    activeFile: z.string().optional(),
    languageId: z.string().optional(),
    documentVersion: z.number().int().nonnegative().optional(),
    documentDirty: z.boolean().optional(),
    activeFileContent: z.string().max(50_000).optional(),
    selection: z.string().max(50_000).optional(),
    selectionStartLine: z.number().int().positive().optional(),
    selectionEndLine: z.number().int().positive().optional(),
    openFiles: z.array(z.string()).max(100).default([]),
    diagnostics: z.array(diagnosticSchema).max(200).default([]),
    gitDiff: z.string().max(100_000).optional(),
  })
  .strict();
export type EditorContext = z.infer<typeof editorContextSchema>;

export const workspaceInfoSchema = z
  .object({
    activeRoot: z.string().nullable(),
    roots: z.array(z.string()),
    trusted: z.boolean(),
    kind: z.enum(["none", "single-root", "multi-root"]),
  })
  .strict();
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

export const taskSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    mode: agentModeSchema,
    phase: taskPhaseSchema,
    createdAt: z.string(),
    completedAt: z.string().optional(),
    answer: z.string().optional(),
    finishReason: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const changeSnapshotSchema = z
  .object({
    changeSetId: z.string().optional(),
    status: z.string(),
    mode: z.enum(["readonly", "preview", "write"]),
    previewAvailable: z.boolean(),
    operations: z.array(stringRecordSchema).default([]),
    totals: z
      .object({
        filesChanged: z.number().int().nonnegative(),
        filesCreated: z.number().int().nonnegative(),
        filesDeleted: z.number().int().nonnegative(),
        filesMoved: z.number().int().nonnegative(),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
      })
      .strict(),
    checkpointId: z.string().optional(),
  })
  .strict();

export const changePreviewSchema = z
  .object({
    changeSetId: z.string(),
    diff: z.string(),
    fileDiffs: z.record(z.string(), z.string()),
    operations: z.array(stringRecordSchema),
    warnings: z.array(z.string()),
    conflicts: z.array(stringRecordSchema),
    totals: changeSnapshotSchema.shape.totals,
    canApply: z.boolean(),
    diffTruncated: z.boolean(),
  })
  .strict();

export const verificationResultSchema = z
  .object({
    id: z.string(),
    status: z.enum(["passed", "failed", "partial", "unavailable", "aborted"]),
    startedAt: z.string(),
    finishedAt: z.string(),
    durationMs: z.number().nonnegative(),
    scope: z.enum(["changed_files", "affected_packages", "workspace"]),
    steps: z.array(stringRecordSchema),
    diagnostics: z.array(diagnosticSchema),
    regressions: z.array(diagnosticSchema),
    preExistingIssues: z.array(diagnosticSchema),
    resolvedIssues: z.array(diagnosticSchema),
    summary: stringRecordSchema,
  })
  .strict();

export const runtimeSettingsSchema = z
  .object({
    ollamaHost: z.string().url(),
    ollamaModel: z.string().trim().min(1),
    maxSteps: z.number().int().min(1).max(1_000),
    contextLength: z.number().int().min(1_024).max(2_000_000),
    temperature: z.number().min(0).max(2),
    mode: agentModeSchema,
    autoStartRuntime: z.boolean(),
    verificationEnabled: z.boolean(),
    requireWriteConfirmation: z.literal(true),
    verifyAfterApply: z.boolean(),
    verificationScope: z.enum(["changed_files", "affected_packages", "workspace"]),
    commandPolicy: z.enum(["disabled", "verification", "restricted", "custom"]),
    allowNetwork: z.boolean(),
    allowPackageInstall: z.boolean(),
    allowFileDelete: z.boolean(),
    allowFileMove: z.boolean(),
    rollbackOnVerificationFailure: z.boolean(),
    maxRepairAttempts: z.number().int().min(0).max(20),
    respectGitignore: z.boolean(),
    includeHiddenFiles: z.boolean(),
    allowSensitiveFiles: z.boolean(),
    commandsEnabled: z.boolean(),
    debug: z.boolean(),
    orchestrationEnabled: z.boolean(),
    orchestrationDefaultMode: z.enum(["analysis", "implementation", "autonomous"]),
    orchestrationMaxAgents: z.number().int().min(1).max(64),
    orchestrationMaxParallelAgents: z.number().int().min(1).max(16),
    orchestrationRequirePlanApproval: z.literal(true),
    orchestrationRequireFinalApproval: z.literal(true),
    orchestrationRequireIndependentReview: z.literal(true),
    orchestrationRequireSecurityReview: z.literal(true),
    orchestrationShowAgentActivity: z.boolean(),
    orchestrationShowTaskGraph: z.boolean(),
    remoteEnabled: z.boolean(),
    remoteProvider: z.literal("github"),
    githubAuthenticationMode: z.enum(["vscode", "token"]),
    githubApiBaseUrl: z.string().url(),
    githubWebBaseUrl: z.string().url(),
    githubAllowEnterprise: z.boolean(),
    githubCreateDraftPullRequest: z.boolean(),
    githubRequirePushConfirmation: z.literal(true),
    githubRequirePullRequestConfirmation: z.literal(true),
    githubRequireCommentConfirmation: z.literal(true),
    githubRequireResolveThreadConfirmation: z.literal(true),
    githubAllowLabelChanges: z.boolean(),
    githubAllowIssueCreation: z.literal(false),
    githubAllowIssueClosing: z.literal(false),
    githubAllowReadyForReview: z.boolean(),
    githubAllowMerge: z.literal(false),
    githubAllowBranchDelete: z.literal(false),
    githubAllowForcePush: z.literal(false),
    githubCiPollingInterval: z.number().int().min(10_000).max(600_000),
    githubCiMaxWait: z.number().int().min(10_000).max(7_200_000),
  })
  .strict();
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

const initializeParamsSchema = z
  .object({ clientName: z.string(), clientVersion: z.string(), workspaceTrusted: z.boolean() })
  .strict();
const initializeResultSchema = z
  .object({
    runtimeName: z.string(),
    runtimeVersion: z.string(),
    protocolVersion: semverSchema,
    capabilities: z.array(z.string()),
  })
  .strict();
const okResultSchema = z.object({ ok: z.literal(true) }).strict();
const taskIdSchema = z.object({ taskId: z.string() }).strict();
const optionalTaskIdSchema = z.object({ taskId: z.string().optional() }).strict();
const verificationIdSchema = z.object({ verificationId: z.string().optional() }).strict();
const remoteRepositoryRequestSchema = z
  .object({ remoteName: z.string().min(1).max(64).optional() })
  .strict();
const approvalDecisionSchema = z.object({
  approvalId: z.string().optional(),
  approved: z.boolean().optional(),
});
const pullRequestTaskSchema = z
  .object({ taskId: z.string(), pullRequestNumber: z.number().int().positive().optional() })
  .strict();
const orchestrationSessionSchema = z.object({ sessionId: z.string().uuid() }).strict();
const orchestrationNodeSchema = orchestrationSessionSchema
  .extend({ nodeId: z.string().min(1) })
  .strict();
const orchestrationModeSchema = z.enum(["analysis", "implementation", "autonomous"]);

export const requestPayloadSchemas = {
  "runtime.initialize": initializeParamsSchema,
  "runtime.shutdown": emptySchema,
  "runtime.health": emptySchema,
  "runtime.getCapabilities": emptySchema,
  "workspace.set": workspaceInfoSchema,
  "workspace.getInfo": emptySchema,
  "task.start": z
    .object({
      task: z.string().trim().min(1).max(100_000),
      mode: agentModeSchema,
      context: editorContextSchema.optional(),
    })
    .strict(),
  "task.cancel": taskIdSchema,
  "task.get": taskIdSchema,
  "task.list": z.object({ limit: z.number().int().min(1).max(50).default(50) }).strict(),
  "agent.sendMessage": z
    .object({
      message: z.string().trim().min(1).max(100_000),
      mode: agentModeSchema,
      context: editorContextSchema.optional(),
    })
    .strict(),
  "agent.getState": emptySchema,
  "changes.getCurrent": emptySchema,
  "changes.preview": emptySchema,
  "changes.apply": z.object({ changeSetId: z.string().optional() }).strict(),
  "changes.reject": z
    .object({ changeSetId: z.string().optional(), reason: z.string().optional() })
    .strict(),
  "verification.run": z
    .object({
      scope: z.enum(["changed_files", "affected_packages", "workspace"]).optional(),
      reason: z.string().optional(),
    })
    .strict(),
  "verification.get": verificationIdSchema,
  "checkpoints.list": emptySchema,
  "checkpoints.restore": z
    .object({ checkpointId: z.string(), reason: z.string().optional() })
    .strict(),
  "settings.update": runtimeSettingsSchema.partial().strict(),
  "settings.get": emptySchema,
  "remote.getStatus": emptySchema,
  "remote.authenticate": z
    .object({ mode: z.enum(["vscode", "token"]), token: z.string().min(1).max(10_000).optional() })
    .strict(),
  "remote.disconnect": emptySchema,
  "remote.getRepository": remoteRepositoryRequestSchema,
  "remote.verifyRepository": remoteRepositoryRequestSchema,
  "remote.getPermissions": remoteRepositoryRequestSchema,
  "remote.getRateLimit": emptySchema,
  "remote.publishTaskBranch": taskIdSchema
    .extend({ remoteName: z.string().optional() })
    .merge(approvalDecisionSchema)
    .strict(),
  "remote.getPublishedBranch": taskIdSchema,
  "pullRequest.createDraft": taskIdSchema
    .extend({
      title: z.string().max(72).optional(),
      summary: z.string().max(10_000).optional(),
      issueNumber: z.number().int().positive().optional(),
      labels: z.array(z.string().min(1).max(100)).max(20).optional(),
    })
    .merge(approvalDecisionSchema)
    .strict(),
  "pullRequest.get": pullRequestTaskSchema,
  "pullRequest.update": taskIdSchema
    .extend({
      title: z.string().max(72).optional(),
      summary: z.string().max(10_000).optional(),
      labels: z.array(z.string()).max(20).optional(),
    })
    .merge(approvalDecisionSchema)
    .strict(),
  "pullRequest.openInBrowser": taskIdSchema,
  "pullRequest.listChecks": taskIdSchema,
  "pullRequest.watchChecks": taskIdSchema
    .extend({ mode: z.enum(["once", "until_complete", "manual"]).default("once") })
    .strict(),
  "pullRequest.cancelWatch": optionalTaskIdSchema,
  "pullRequest.getCheckLogs": taskIdSchema.extend({ checkId: z.string() }).strict(),
  "pullRequest.analyzeCheck": taskIdSchema.extend({ checkId: z.string() }).strict(),
  "pullRequest.listReviews": taskIdSchema,
  "pullRequest.listThreads": taskIdSchema,
  "pullRequest.getThread": taskIdSchema.extend({ threadId: z.string() }).strict(),
  "pullRequest.replyToThread": taskIdSchema
    .extend({ threadId: z.string(), body: z.string().min(1).max(20_000), commitSha: z.string() })
    .merge(approvalDecisionSchema)
    .strict(),
  "pullRequest.resolveThread": taskIdSchema
    .extend({ threadId: z.string() })
    .merge(approvalDecisionSchema)
    .strict(),
  "pullRequest.linkIssue": taskIdSchema
    .extend({
      issueNumber: z.number().int().positive(),
      keyword: z.enum(["Closes", "Fixes", "Refs"]),
    })
    .merge(approvalDecisionSchema)
    .strict(),
  "pullRequest.setLabels": taskIdSchema
    .extend({ labels: z.array(z.string().min(1).max(100)).max(20) })
    .merge(approvalDecisionSchema)
    .strict(),
  "orchestration.getStatus": emptySchema,
  "orchestration.create": z
    .object({
      task: z.string().trim().min(1).max(100_000),
      mode: orchestrationModeSchema.default("analysis"),
      files: z.array(z.string().min(1)).max(500).optional(),
      includePerformance: z.boolean().optional(),
      includeDocumentation: z.boolean().optional(),
    })
    .strict(),
  "orchestration.get": orchestrationSessionSchema,
  "orchestration.list": emptySchema,
  "orchestration.cancel": orchestrationSessionSchema,
  "orchestration.resume": orchestrationSessionSchema,
  "orchestration.getPlan": orchestrationSessionSchema,
  "orchestration.approvePlan": orchestrationSessionSchema,
  "orchestration.rejectPlan": orchestrationSessionSchema,
  "orchestration.getTaskGraph": orchestrationSessionSchema,
  "orchestration.getNode": orchestrationNodeSchema,
  "orchestration.retryNode": orchestrationNodeSchema,
  "orchestration.cancelNode": orchestrationNodeSchema,
  "orchestration.getAgents": orchestrationSessionSchema,
  "orchestration.getAgent": orchestrationSessionSchema
    .extend({ agentId: z.string().min(1) })
    .strict(),
  "orchestration.getArtifacts": orchestrationSessionSchema,
  "orchestration.getConflicts": orchestrationSessionSchema,
  "orchestration.getReview": orchestrationSessionSchema,
  "orchestration.approveResult": orchestrationSessionSchema,
  "orchestration.rejectResult": orchestrationSessionSchema,
} satisfies Record<ProcedureName, z.ZodType>;

export const responsePayloadSchemas = {
  "runtime.initialize": initializeResultSchema,
  "runtime.shutdown": okResultSchema,
  "runtime.health": z
    .object({
      status: z.enum(["ok", "busy", "degraded"]),
      uptimeMs: z.number().nonnegative(),
      activeTaskId: z.string().optional(),
    })
    .strict(),
  "runtime.getCapabilities": z
    .object({ capabilities: z.array(z.string()), protocolVersion: semverSchema })
    .strict(),
  "workspace.set": workspaceInfoSchema,
  "workspace.getInfo": workspaceInfoSchema,
  "task.start": taskSummarySchema,
  "task.cancel": okResultSchema,
  "task.get": z.object({ task: taskSummarySchema.nullable() }).strict(),
  "task.list": z.object({ tasks: z.array(taskSummarySchema) }).strict(),
  "agent.sendMessage": taskSummarySchema,
  "agent.getState": z
    .object({ state: runtimeStateSchema, activeTask: taskSummarySchema.nullable() })
    .strict(),
  "changes.getCurrent": z.object({ changes: changeSnapshotSchema.nullable() }).strict(),
  "changes.preview": changePreviewSchema,
  "changes.apply": stringRecordSchema,
  "changes.reject": okResultSchema,
  "verification.run": verificationResultSchema,
  "verification.get": z.object({ verification: verificationResultSchema.nullable() }).strict(),
  "checkpoints.list": z.object({ checkpoints: z.array(stringRecordSchema) }).strict(),
  "checkpoints.restore": stringRecordSchema,
  "settings.update": runtimeSettingsSchema,
  "settings.get": runtimeSettingsSchema,
  "remote.getStatus": stringRecordSchema,
  "remote.authenticate": z.object({ user: stringRecordSchema }).strict(),
  "remote.disconnect": okResultSchema,
  "remote.getRepository": z.object({ repository: stringRecordSchema }).strict(),
  "remote.verifyRepository": stringRecordSchema,
  "remote.getPermissions": z.object({ permissions: stringRecordSchema }).strict(),
  "remote.getRateLimit": stringRecordSchema,
  "remote.publishTaskBranch": stringRecordSchema,
  "remote.getPublishedBranch": stringRecordSchema,
  "pullRequest.createDraft": stringRecordSchema,
  "pullRequest.get": stringRecordSchema,
  "pullRequest.update": stringRecordSchema,
  "pullRequest.openInBrowser": z.object({ url: z.string().url() }).strict(),
  "pullRequest.listChecks": z.object({ checks: z.array(stringRecordSchema) }).strict(),
  "pullRequest.watchChecks": z.object({ checks: z.array(stringRecordSchema) }).strict(),
  "pullRequest.cancelWatch": okResultSchema,
  "pullRequest.getCheckLogs": stringRecordSchema,
  "pullRequest.analyzeCheck": stringRecordSchema,
  "pullRequest.listReviews": z.object({ reviews: z.array(stringRecordSchema) }).strict(),
  "pullRequest.listThreads": z.object({ threads: z.array(stringRecordSchema) }).strict(),
  "pullRequest.getThread": stringRecordSchema,
  "pullRequest.replyToThread": stringRecordSchema,
  "pullRequest.resolveThread": stringRecordSchema,
  "pullRequest.linkIssue": stringRecordSchema,
  "pullRequest.setLabels": stringRecordSchema,
  "orchestration.getStatus": stringRecordSchema,
  "orchestration.create": stringRecordSchema,
  "orchestration.get": stringRecordSchema,
  "orchestration.list": z.object({ sessions: z.array(stringRecordSchema) }).strict(),
  "orchestration.cancel": stringRecordSchema,
  "orchestration.resume": stringRecordSchema,
  "orchestration.getPlan": z.object({ plans: z.array(stringRecordSchema) }).strict(),
  "orchestration.approvePlan": stringRecordSchema,
  "orchestration.rejectPlan": stringRecordSchema,
  "orchestration.getTaskGraph": stringRecordSchema,
  "orchestration.getNode": stringRecordSchema,
  "orchestration.retryNode": stringRecordSchema,
  "orchestration.cancelNode": stringRecordSchema,
  "orchestration.getAgents": z.object({ agents: z.array(stringRecordSchema) }).strict(),
  "orchestration.getAgent": stringRecordSchema,
  "orchestration.getArtifacts": z.object({ artifacts: z.array(stringRecordSchema) }).strict(),
  "orchestration.getConflicts": z.object({ conflicts: z.array(stringRecordSchema) }).strict(),
  "orchestration.getReview": z.object({ review: stringRecordSchema.nullable() }).strict(),
  "orchestration.approveResult": stringRecordSchema,
  "orchestration.rejectResult": stringRecordSchema,
} satisfies Record<ProcedureName, z.ZodType>;

const taskEventSchema = taskIdSchema
  .extend({ phase: taskPhaseSchema.optional(), message: z.string().optional() })
  .strict();
const toolEventSchema = taskIdSchema
  .extend({
    toolCallId: z.string(),
    toolName: z.string(),
    durationMs: z.number().nonnegative().optional(),
    error: z.string().optional(),
  })
  .strict();

export const notificationPayloadSchemas = {
  "runtime.ready": z.object({ runtimeVersion: z.string(), protocolVersion: semverSchema }).strict(),
  "runtime.error": z
    .object({ code: z.string(), message: z.string(), recoverable: z.boolean() })
    .strict(),
  "task.created": taskSummarySchema,
  "task.phaseChanged": taskEventSchema,
  "task.progress": taskEventSchema,
  "task.completed": taskSummarySchema,
  "task.failed": taskSummarySchema,
  "task.cancelled": taskSummarySchema,
  "agent.message": taskIdSchema
    .extend({ role: z.enum(["assistant", "system"]), content: z.string() })
    .strict(),
  "agent.toolCallStarted": toolEventSchema,
  "agent.toolCallCompleted": toolEventSchema,
  "agent.toolCallFailed": toolEventSchema,
  "changes.updated": z.object({ changes: changeSnapshotSchema }).strict(),
  "changes.previewReady": changePreviewSchema,
  "changes.applied": stringRecordSchema,
  "changes.rejected": z
    .object({ changeSetId: z.string().optional(), reason: z.string().optional() })
    .strict(),
  "verification.started": z
    .object({ taskId: z.string().optional(), reason: z.string().optional() })
    .strict(),
  "verification.stepStarted": z
    .object({
      verificationId: z.string().optional(),
      commandId: z.string(),
      displayName: z.string(),
    })
    .strict(),
  "verification.stepCompleted": z
    .object({ verificationId: z.string().optional(), commandId: z.string(), status: z.string() })
    .strict(),
  "verification.completed": verificationResultSchema,
  "checkpoint.created": z
    .object({ checkpointId: z.string(), reason: z.string().optional() })
    .strict(),
  "checkpoint.restored": z.object({ checkpointId: z.string() }).strict(),
  "remote.authenticationChanged": stringRecordSchema,
  "remote.repositoryVerified": stringRecordSchema,
  "remote.permissionChanged": stringRecordSchema,
  "remote.rateLimitChanged": stringRecordSchema,
  "remote.publishApprovalRequired": stringRecordSchema,
  "remote.branchPublished": stringRecordSchema,
  "remote.branchPublishFailed": stringRecordSchema,
  "pullRequest.createApprovalRequired": stringRecordSchema,
  "pullRequest.created": stringRecordSchema,
  "pullRequest.updated": stringRecordSchema,
  "pullRequest.checksChanged": z.object({ checks: z.array(stringRecordSchema) }).strict(),
  "pullRequest.checkStarted": stringRecordSchema,
  "pullRequest.checkCompleted": stringRecordSchema,
  "pullRequest.ciAnalysisReady": stringRecordSchema,
  "pullRequest.reviewThreadsChanged": z.object({ threads: z.array(stringRecordSchema) }).strict(),
  "pullRequest.reviewReplyApprovalRequired": stringRecordSchema,
  "pullRequest.reviewReplySent": stringRecordSchema,
  "pullRequest.resolveApprovalRequired": stringRecordSchema,
  "pullRequest.threadResolved": stringRecordSchema,
  "remote.securityWarning": z
    .object({ code: z.string(), message: z.string(), critical: z.boolean() })
    .strict(),
  "orchestration.created": stringRecordSchema,
  "orchestration.planReady": stringRecordSchema,
  "orchestration.planApproved": stringRecordSchema,
  "orchestration.stateChanged": stringRecordSchema,
  "orchestration.taskGraphUpdated": stringRecordSchema,
  "orchestration.nodeStarted": stringRecordSchema,
  "orchestration.nodeProgress": stringRecordSchema,
  "orchestration.nodeCompleted": stringRecordSchema,
  "orchestration.nodeFailed": stringRecordSchema,
  "orchestration.nodeBlocked": stringRecordSchema,
  "orchestration.agentStarted": stringRecordSchema,
  "orchestration.agentCompleted": stringRecordSchema,
  "orchestration.agentFailed": stringRecordSchema,
  "orchestration.artifactCreated": stringRecordSchema,
  "orchestration.conflictDetected": stringRecordSchema,
  "orchestration.replanStarted": stringRecordSchema,
  "orchestration.replanCompleted": stringRecordSchema,
  "orchestration.reviewReady": stringRecordSchema,
  "orchestration.securityBlocked": stringRecordSchema,
  "orchestration.approvalRequired": stringRecordSchema,
  "orchestration.completed": stringRecordSchema,
  "orchestration.failed": stringRecordSchema,
  "orchestration.cancelled": stringRecordSchema,
} satisfies Record<NotificationName, z.ZodType>;

const envelopeBaseSchema = z
  .object({ protocolVersion: semverSchema, sessionId: sessionIdSchema, payload: z.unknown() })
  .strict();
export type ProtocolEnvelope<T = unknown> = {
  protocolVersion: string;
  sessionId: string;
  payload: T;
};

const requestBaseSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: jsonRpcIdSchema,
    method: z.string(),
    params: envelopeBaseSchema,
  })
  .strict();
const notificationBaseSchema = z
  .object({ jsonrpc: z.literal(JSON_RPC_VERSION), method: z.string(), params: envelopeBaseSchema })
  .strict();
const responseBaseSchema = z
  .object({ jsonrpc: z.literal(JSON_RPC_VERSION), id: jsonRpcIdSchema, result: envelopeBaseSchema })
  .strict();
const errorResponseSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: z.union([jsonRpcIdSchema, z.null()]),
    error: z
      .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
      .strict(),
  })
  .strict();

export interface JsonRpcRequest<M extends ProcedureName = ProcedureName> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  method: M;
  params: ProtocolEnvelope;
}
export interface JsonRpcNotification<N extends NotificationName = NotificationName> {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: N;
  params: ProtocolEnvelope;
}
export interface JsonRpcResponse {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  result: ProtocolEnvelope;
}
export type JsonRpcErrorResponse = z.infer<typeof errorResponseSchema>;

function major(version: string): number {
  return Number(version.split(".")[0]);
}

export function assertCompatibleVersion(version: string): void {
  if (!semverSchema.safeParse(version).success || major(version) !== major(PROTOCOL_VERSION)) {
    throw new ProtocolError(
      `Niezgodna wersja protokołu: ${version}; runtime obsługuje ${PROTOCOL_VERSION}.`,
      "VERSION_MISMATCH",
    );
  }
}

export function envelope<T>(sessionId: string, payload: T): ProtocolEnvelope<T> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: sessionIdSchema.parse(sessionId),
    payload,
  };
}

export function createRequest<M extends ProcedureName>(
  id: JsonRpcId,
  method: M,
  sessionId: string,
  payload: z.input<(typeof requestPayloadSchemas)[M]>,
): JsonRpcRequest<M> {
  const parsed = requestPayloadSchemas[method].parse(payload);
  return { jsonrpc: JSON_RPC_VERSION, id, method, params: envelope(sessionId, parsed) };
}

export function createNotification<N extends NotificationName>(
  method: N,
  sessionId: string,
  payload: z.input<(typeof notificationPayloadSchemas)[N]>,
): JsonRpcNotification<N> {
  const parsed = notificationPayloadSchemas[method].parse(payload);
  return { jsonrpc: JSON_RPC_VERSION, method, params: envelope(sessionId, parsed) };
}

export function createResponse<M extends ProcedureName>(
  id: JsonRpcId,
  method: M,
  sessionId: string,
  payload: z.input<(typeof responsePayloadSchemas)[M]>,
): JsonRpcResponse {
  const parsed = responsePayloadSchemas[method].parse(payload);
  return { jsonrpc: JSON_RPC_VERSION, id, result: envelope(sessionId, parsed) };
}

export function createErrorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return errorResponseSchema.parse({
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

export function parseRequest(value: unknown): JsonRpcRequest {
  const base = requestBaseSchema.safeParse(value);
  if (!base.success)
    throw new ProtocolError(
      "Nieprawidłowe żądanie JSON-RPC.",
      "INVALID_MESSAGE",
      base.error.issues,
    );
  if (!procedureNames.includes(base.data.method as ProcedureName))
    throw new ProtocolError(`Nieznana procedura: ${base.data.method}.`, "UNKNOWN_METHOD");
  assertCompatibleVersion(base.data.params.protocolVersion);
  const method = base.data.method as ProcedureName;
  const payload = requestPayloadSchemas[method].safeParse(base.data.params.payload);
  if (!payload.success)
    throw new ProtocolError(
      `Nieprawidłowy payload dla ${method}.`,
      "INVALID_MESSAGE",
      payload.error.issues,
    );
  return { ...base.data, method, params: { ...base.data.params, payload: payload.data } };
}

export function parseNotification(value: unknown): JsonRpcNotification {
  const base = notificationBaseSchema.safeParse(value);
  if (!base.success)
    throw new ProtocolError(
      "Nieprawidłowa notyfikacja JSON-RPC.",
      "INVALID_MESSAGE",
      base.error.issues,
    );
  if (!notificationNames.includes(base.data.method as NotificationName))
    throw new ProtocolError(`Nieznana notyfikacja: ${base.data.method}.`, "UNKNOWN_METHOD");
  assertCompatibleVersion(base.data.params.protocolVersion);
  const method = base.data.method as NotificationName;
  const payload = notificationPayloadSchemas[method].safeParse(base.data.params.payload);
  if (!payload.success)
    throw new ProtocolError(
      `Nieprawidłowy payload dla ${method}.`,
      "INVALID_MESSAGE",
      payload.error.issues,
    );
  return { ...base.data, method, params: { ...base.data.params, payload: payload.data } };
}

export function parseResponse(
  method: ProcedureName,
  value: unknown,
): JsonRpcResponse | JsonRpcErrorResponse {
  const failure = errorResponseSchema.safeParse(value);
  if (failure.success) return failure.data;
  const base = responseBaseSchema.safeParse(value);
  if (!base.success)
    throw new ProtocolError(
      "Nieprawidłowa odpowiedź JSON-RPC.",
      "INVALID_MESSAGE",
      base.error.issues,
    );
  assertCompatibleVersion(base.data.result.protocolVersion);
  const payload = responsePayloadSchemas[method].safeParse(base.data.result.payload);
  if (!payload.success)
    throw new ProtocolError(
      `Nieprawidłowy wynik ${method}.`,
      "INVALID_MESSAGE",
      payload.error.issues,
    );
  return { ...base.data, result: { ...base.data.result, payload: payload.data } };
}

export function assertSession(expected: string, actual: string): void {
  if (expected !== actual)
    throw new ProtocolError(`Odpowiedź należy do innej sesji (${actual}).`, "SESSION_MISMATCH");
}

import { z } from "zod";

import {
  agentModeSchema,
  runtimeStateSchema,
  taskSummarySchema,
} from "@local-code-agent/runtime-protocol";

export const editorContextKindSchema = z.enum([
  "none",
  "activeFile",
  "selection",
  "openFiles",
  "diagnostics",
  "gitDiff",
]);

export const tabIdSchema = z.enum([
  "chat",
  "tasks",
  "changes",
  "verification",
  "orchestration",
  "github",
]);
export type TabId = z.infer<typeof tabIdSchema>;

const compactString = z.string().max(4_000);
const historyItemSchema = z
  .object({
    id: compactString,
    title: compactString,
    mode: compactString,
    status: compactString,
    createdAt: compactString,
    filesChanged: z.number().int().nonnegative(),
    verificationStatus: compactString.optional(),
  })
  .strict();

const changeItemSchema = z
  .object({
    id: compactString,
    path: compactString,
    operation: z.enum(["create", "modify", "delete", "move"]),
    reason: compactString.optional(),
  })
  .strict();

const checkpointSchema = z
  .object({ id: compactString, task: compactString, createdAt: compactString.optional() })
  .strict();

const verificationStepSchema = z
  .object({
    id: compactString,
    name: compactString,
    kind: z.enum(["test", "lint", "typecheck", "build", "other"]),
    status: compactString,
    details: z.string().max(100_000).optional(),
    durationMs: z.number().nonnegative().optional(),
  })
  .strict();

const verificationSchema = z
  .object({
    status: compactString,
    durationMs: z.number().nonnegative().optional(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    steps: z.array(verificationStepSchema).max(200),
  })
  .strict();

const orchestrationItemSchema = z
  .object({ id: compactString, title: compactString, status: compactString })
  .strict();

const orchestrationSchema = z
  .object({
    sessionId: compactString,
    status: compactString,
    mode: compactString,
    stage: compactString,
    requiresAction: z.boolean(),
    securityBlocked: z.boolean(),
    agents: z.array(orchestrationItemSchema).max(100),
    tasks: z.array(orchestrationItemSchema).max(500),
    reviewStatus: compactString.optional(),
  })
  .strict();

const githubSchema = z
  .object({
    enabled: z.boolean(),
    connected: z.boolean(),
    account: compactString.optional(),
    repository: compactString.optional(),
    permission: compactString,
    pullRequest: compactString.optional(),
    checksStatus: compactString.optional(),
    apiLimit: compactString.optional(),
    error: compactString.optional(),
  })
  .strict();

export const webviewToHostSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("webview.ready") }).strict(),
  z
    .object({
      type: z.literal("task.submit"),
      task: z.string().trim().min(1).max(100_000),
      mode: agentModeSchema,
      context: editorContextKindSchema,
    })
    .strict(),
  z.object({ type: z.literal("task.cancel") }).strict(),
  z.object({ type: z.literal("mode.change"), mode: agentModeSchema }).strict(),
  z.object({ type: z.literal("context.change"), context: editorContextKindSchema }).strict(),
  z.object({ type: z.literal("changes.preview") }).strict(),
  z.object({ type: z.literal("changes.apply") }).strict(),
  z.object({ type: z.literal("changes.reject") }).strict(),
  z.object({ type: z.literal("verification.run") }).strict(),
  z.object({ type: z.literal("checkpoint.restore"), checkpointId: compactString }).strict(),
  z.object({ type: z.literal("task.open"), taskId: compactString }).strict(),
  z.object({ type: z.literal("file.open"), path: compactString }).strict(),
  z.object({ type: z.literal("diff.open"), path: compactString }).strict(),
  z.object({ type: z.literal("settings.open") }).strict(),
  z.object({ type: z.literal("logs.open") }).strict(),
  z.object({ type: z.literal("runtime.restart") }).strict(),
  z.object({ type: z.literal("orchestration.approve") }).strict(),
  z.object({ type: z.literal("orchestration.reject") }).strict(),
  z
    .object({
      type: z.literal("github.action"),
      action: z.enum(["connect", "refresh", "publish", "draftPr"]),
    })
    .strict(),
]);
export type WebviewToHostMessage = z.infer<typeof webviewToHostSchema>;

const chatMessageSchema = z
  .object({
    id: compactString,
    role: z.enum(["user", "assistant", "system", "error"]),
    content: z.string().max(200_000),
  })
  .strict();

export const viewStateSchema = z
  .object({
    runtimeState: runtimeStateSchema,
    mode: agentModeSchema,
    context: editorContextKindSchema,
    workspaceLabel: compactString,
    trusted: z.boolean(),
    task: taskSummarySchema.nullable(),
    messages: z.array(chatMessageSchema).max(100),
    history: z.array(historyItemSchema).max(50),
    changes: z.array(changeItemSchema).max(2_000),
    changeStatus: compactString.optional(),
    checkpoints: z.array(checkpointSchema).max(200),
    verification: verificationSchema.nullable(),
    orchestration: orchestrationSchema.nullable(),
    github: githubSchema,
    error: compactString.nullable(),
  })
  .strict();
export type AgentViewState = z.infer<typeof viewStateSchema>;

export const hostToWebviewSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state.initial"), state: viewStateSchema }).strict(),
  z.object({ type: z.literal("state.updated"), state: viewStateSchema }).strict(),
  z
    .object({
      type: z.literal("agent.message"),
      role: z.enum(["assistant", "system", "error"]),
      content: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("error.show"), message: z.string(), code: z.string().optional() }).strict(),
  z.object({ type: z.literal("runtime.updated"), state: runtimeStateSchema }).strict(),
]);
export type HostToWebviewMessage = z.infer<typeof hostToWebviewSchema>;

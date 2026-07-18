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
  z.object({ type: z.literal("checkpoint.restore"), checkpointId: z.string() }).strict(),
  z.object({ type: z.literal("file.open"), path: z.string() }).strict(),
  z.object({ type: z.literal("diff.open"), path: z.string() }).strict(),
  z.object({ type: z.literal("settings.open") }).strict(),
  z.object({ type: z.literal("runtime.restart") }).strict(),
]);
export type WebviewToHostMessage = z.infer<typeof webviewToHostSchema>;

const chatMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant", "system"]),
    content: z.string().max(200_000),
  })
  .strict();

export const viewStateSchema = z
  .object({
    runtimeState: runtimeStateSchema,
    mode: agentModeSchema,
    context: editorContextKindSchema,
    workspaceLabel: z.string(),
    trusted: z.boolean(),
    task: taskSummarySchema.nullable(),
    messages: z.array(chatMessageSchema).max(100),
    changes: z.record(z.string(), z.unknown()).nullable(),
    verification: z.record(z.string(), z.unknown()).nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type AgentViewState = z.infer<typeof viewStateSchema>;

export const hostToWebviewSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state.initial"), state: viewStateSchema }).strict(),
  z.object({ type: z.literal("state.updated"), state: viewStateSchema }).strict(),
  z.object({ type: z.literal("task.updated"), task: taskSummarySchema }).strict(),
  z
    .object({
      type: z.literal("agent.message"),
      role: z.enum(["assistant", "system"]),
      content: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("tool.updated"), tool: z.record(z.string(), z.unknown()) }).strict(),
  z
    .object({ type: z.literal("changes.updated"), changes: z.record(z.string(), z.unknown()) })
    .strict(),
  z
    .object({
      type: z.literal("verification.updated"),
      verification: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({ type: z.literal("error.show"), message: z.string(), code: z.string().optional() })
    .strict(),
  z.object({ type: z.literal("runtime.updated"), state: runtimeStateSchema }).strict(),
]);
export type HostToWebviewMessage = z.infer<typeof hostToWebviewSchema>;

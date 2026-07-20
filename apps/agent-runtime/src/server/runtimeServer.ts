import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";

import {
  JSON_RPC_VERSION,
  PROTOCOL_VERSION,
  ProtocolError,
  assertSession,
  createErrorResponse,
  envelope,
  notificationPayloadSchemas,
  parseRequest,
  procedureNames,
  responsePayloadSchemas,
  type AgentMode,
  type JsonRpcId,
  type JsonRpcRequest,
  type NotificationName,
  type ProcedureName,
  type RuntimeSettings,
  type TaskPhase,
  type TaskSummary,
  type WorkspaceInfo,
} from "@local-code-agent/runtime-protocol";
import { LocalChangeService } from "@local-code-agent/change-engine";
import type { CommandResult, CommandSpec } from "@local-code-agent/command-runner";
import type {
  VerificationDiagnostic,
  VerificationResult,
} from "@local-code-agent/project-verifier";
import { LocalWorkspaceService } from "@local-code-agent/workspace";

import { AgentLoop } from "../agent/agentLoop.js";
import type { AgentLoopObserver } from "../agent/agentTypes.js";
import { createCommandRunner, createRegistry, createVerifier } from "../cli.js";
import { loadConfig, type AgentConfig } from "../config.js";
import { OllamaClient } from "../ollamaClient.js";
import { OrchestrationRuntimeService } from "../orchestration/orchestrationRuntimeService.js";
import { VerificationCoordinator } from "../verificationCoordinator.js";
import {
  RemoteRuntimeService,
  type PreparedPublish,
  type PreparedPullRequest,
  type PreparedPullRequestUpdate,
} from "../remote/remoteRuntimeService.js";
import { registerRemoteTools } from "../tools/remoteTools.js";

const RUNTIME_VERSION = "0.2.0";
const MAX_HISTORY = 50;

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  ollamaHost: "http://127.0.0.1:11434",
  ollamaModel: "qwen3.5:9b",
  ollamaKeepAlive: "3m",
  maxSteps: 12,
  contextLength: 8_192,
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
  orchestrationMaxParallelAgents: 1,
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
};

interface TaskRecord extends TaskSummary {
  controller: AbortController;
}

interface SessionResources {
  config: AgentConfig;
  changes: LocalChangeService;
  verifier: ReturnType<typeof createVerifier>;
  coordinator: VerificationCoordinator;
}

type ServerErrorCode =
  | "RUNTIME_BUSY"
  | "WORKSPACE_REQUIRED"
  | "WORKSPACE_UNTRUSTED"
  | "TASK_NOT_FOUND"
  | "NO_ACTIVE_CHANGES"
  | "CHANGESET_MISMATCH"
  | "INVALID_REQUEST";

class RuntimeRequestError extends Error {
  public constructor(
    public readonly code: ServerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeRequestError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeRequestError("INVALID_REQUEST", "Payload musi być obiektem.");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new RuntimeRequestError("INVALID_REQUEST", `Pole ${name} musi być tekstem.`);
  }
  return value;
}

function modeToAccess(mode: AgentMode): AgentConfig["accessMode"] {
  if (mode === "edit" || mode === "agent") return "write";
  return "readonly";
}

function contextPrompt(task: string, mode: AgentMode, context: unknown): string {
  const rules = [
    `Tryb interfejsu VS Code: ${mode}.`,
    mode === "ask"
      ? "Odpowiadaj wyłącznie analitycznie. Nie przygotowuj zmian i nie uruchamiaj poleceń."
      : mode === "plan"
        ? "Przygotuj plan. Nie przygotowuj zmian i nie uruchamiaj poleceń."
        : mode === "edit"
          ? "Przygotuj zmiany i preview, ale nie zapisuj ich do workspace."
          : mode === "agent"
            ? "Możesz przygotować pełny ChangeSet. Zapis wymaga późniejszego potwierdzenia użytkownika w VS Code."
            : "Zadanie jest prowadzone przez orkiestrator i wymaga osobnych bramek zatwierdzenia.",
  ];
  if (context !== undefined) {
    rules.push(`Kontekst przekazany przez VS Code:\n${JSON.stringify(context)}`);
  }
  return `${rules.join("\n")}\n\nZadanie użytkownika:\n${task}`;
}

function publicTask(task: TaskRecord): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    mode: task.mode,
    phase: task.phase,
    createdAt: task.createdAt,
    ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
    ...(task.answer === undefined ? {} : { answer: task.answer }),
    ...(task.finishReason === undefined ? {} : { finishReason: task.finishReason }),
    ...(task.error === undefined ? {} : { error: task.error }),
  };
}

function diagnostic(value: VerificationDiagnostic): {
  path: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  severity: "error" | "warning" | "information";
  message: string;
  source: string;
  code?: string;
} {
  return {
    path: value.file ?? "",
    ...(value.line === undefined ? {} : { line: value.line }),
    ...(value.column === undefined ? {} : { column: value.column }),
    ...(value.endLine === undefined ? {} : { endLine: value.endLine }),
    ...(value.endColumn === undefined ? {} : { endColumn: value.endColumn }),
    severity: value.severity === "info" ? "information" : value.severity,
    message: value.message,
    source: `local-code-agent:${value.source}`,
    ...(value.code === undefined ? {} : { code: value.code }),
  };
}

function publicVerification(result: VerificationResult): Record<string, unknown> {
  return {
    ...result,
    steps: result.steps.map((step) => ({
      ...step,
      diagnostics: step.diagnostics.map(diagnostic),
    })),
    diagnostics: result.diagnostics.map(diagnostic),
    regressions: result.regressions.map(diagnostic),
    preExistingIssues: result.preExistingIssues.map(diagnostic),
    resolvedIssues: result.resolvedIssues.map(diagnostic),
  };
}

function errorDetails(error: unknown): { code: string; message: string; recoverable: boolean } {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "RUNTIME_ERROR";
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    recoverable: code !== "TRANSACTION_FAILED" && code !== "ROLLBACK_FAILED",
  };
}

export interface RuntimeServerOptions {
  input: Readable;
  output: Writable;
  errorOutput?: Writable;
  sessionId?: string;
  now?: () => number;
}

export class RuntimeServer {
  private sessionId: string | undefined;
  private readonly startedAt: number;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly history: TaskRecord[] = [];
  private activeTask: TaskRecord | undefined;
  private resources: SessionResources | undefined;
  private workspace: WorkspaceInfo = {
    activeRoot: null,
    roots: [],
    trusted: false,
    kind: "none",
  };
  private settings: RuntimeSettings = { ...DEFAULT_RUNTIME_SETTINGS };
  private approvalOnce = false;
  private shuttingDown = false;
  private remote: RemoteRuntimeService | undefined;
  private orchestration: OrchestrationRuntimeService | undefined;
  private readonly preparedPublishes = new Map<string, PreparedPublish>();
  private readonly preparedPullRequests = new Map<string, PreparedPullRequest>();
  private readonly preparedPullRequestUpdates = new Map<string, PreparedPullRequestUpdate>();
  private readonly preparedReplies = new Map<
    string,
    { taskId: string; threadId: string; body: string; commitSha: string; approvalId: string }
  >();
  private readonly preparedResolutions = new Map<
    string,
    { taskId: string; threadId: string; approvalId: string }
  >();

  public constructor(private readonly options: RuntimeServerOptions) {
    this.sessionId = options.sessionId;
    this.startedAt = (options.now ?? Date.now)();
  }

  private log(message: string): void {
    this.options.errorOutput?.write(`[runtime] ${message}\n`);
  }

  private write(value: unknown): void {
    this.options.output.write(`${JSON.stringify(value)}\n`);
  }

  private notify(method: NotificationName, payload: unknown): void {
    if (this.sessionId === undefined) return;
    const parsed = notificationPayloadSchemas[method].parse(payload);
    this.write({ jsonrpc: JSON_RPC_VERSION, method, params: envelope(this.sessionId, parsed) });
  }

  private result(id: JsonRpcId, method: ProcedureName, payload: unknown): void {
    if (this.sessionId === undefined) {
      throw new RuntimeRequestError(
        "INVALID_REQUEST",
        "Sesja runtime nie została zainicjalizowana.",
      );
    }
    const parsed = responsePayloadSchemas[method].parse(payload);
    this.write({ jsonrpc: JSON_RPC_VERSION, id, result: envelope(this.sessionId, parsed) });
  }

  private failure(id: JsonRpcId | null, error: unknown): void {
    const details = errorDetails(error);
    const code =
      error instanceof ProtocolError
        ? -32_600
        : error instanceof RuntimeRequestError
          ? -32_002
          : -32_603;
    this.write(
      createErrorResponse(id, code, details.message, {
        code: details.code,
        recoverable: details.recoverable,
      }),
    );
    if (this.sessionId !== undefined) this.notify("runtime.error", details);
  }

  private ensureWorkspace(mode: AgentMode, context: Record<string, unknown> | undefined): void {
    if (this.workspace.trusted && this.workspace.activeRoot !== null) return;
    if (
      !this.workspace.trusted &&
      mode === "ask" &&
      typeof context?.selection === "string" &&
      context.selection !== ""
    )
      return;
    if (!this.workspace.trusted) {
      throw new RuntimeRequestError(
        "WORKSPACE_UNTRUSTED",
        "Niezaufany workspace pozwala wyłącznie na tryb Ask z jawnie przekazanym zaznaczeniem.",
      );
    }
    throw new RuntimeRequestError("WORKSPACE_REQUIRED", "Wybierz aktywny folder workspace.");
  }

  private async configFor(mode: AgentMode): Promise<AgentConfig> {
    const workspace = this.workspace.activeRoot ?? process.cwd();
    const restricted = mode === "ask" || mode === "plan" || !this.workspace.trusted;
    return loadConfig({
      overrides: {
        workspace,
        ollamaHost: this.settings.ollamaHost,
        ollamaModel: this.settings.ollamaModel,
        ollamaKeepAlive: this.settings.ollamaKeepAlive,
        maxSteps: this.settings.maxSteps,
        contextLength: this.settings.contextLength,
        temperature: this.settings.temperature,
        accessMode: modeToAccess(mode),
        verificationEnabled: restricted ? false : this.settings.verificationEnabled,
        verifyAfterApply: restricted ? false : this.settings.verifyAfterApply,
        verificationScope: this.settings.verificationScope,
        commandExecutionEnabled: !restricted && this.settings.commandsEnabled,
        commandPolicy: restricted ? "disabled" : this.settings.commandPolicy,
        allowNetwork: restricted ? false : this.settings.allowNetwork,
        allowPackageInstall: restricted ? false : this.settings.allowPackageInstall,
        allowFileDelete: restricted ? false : this.settings.allowFileDelete,
        allowFileMove: restricted ? false : this.settings.allowFileMove,
        rollbackOnVerificationFailure: this.settings.rollbackOnVerificationFailure,
        maxRepairAttempts: this.settings.maxRepairAttempts,
        respectGitignore: this.settings.respectGitignore,
        includeHiddenFiles: this.settings.includeHiddenFiles,
        allowSensitiveFiles: restricted ? false : this.settings.allowSensitiveFiles,
        debug: this.settings.debug,
        orchestrationEnabled: this.settings.orchestrationEnabled,
        orchestrationMaxAgents: this.settings.orchestrationMaxAgents,
        orchestrationMaxParallelAgents: this.settings.orchestrationMaxParallelAgents,
        orchestrationRequirePlanApproval: true,
        orchestrationRequireFinalApproval: true,
        orchestrationRequireReview: true,
        orchestrationRequireSecurityReview: true,
        requireWriteConfirmation: true,
        remoteEnabled: this.settings.remoteEnabled,
        remoteProvider: this.settings.remoteProvider,
        githubAuthMode: this.settings.githubAuthenticationMode,
        githubApiBaseUrl: this.settings.githubApiBaseUrl,
        githubWebBaseUrl: this.settings.githubWebBaseUrl,
        githubAllowEnterprise: this.settings.githubAllowEnterprise,
        githubCreateDraftPr: this.settings.githubCreateDraftPullRequest,
        githubRequirePushConfirmation: true,
        githubRequirePrConfirmation: true,
        githubRequireCommentConfirmation: true,
        githubRequireResolveThreadConfirmation: true,
        githubAllowLabelChanges: this.settings.githubAllowLabelChanges,
        githubAllowIssueCreation: false,
        githubAllowIssueClosing: false,
        githubAllowPrReadyForReview: this.settings.githubAllowReadyForReview,
        githubAllowPrMerge: false,
        githubAllowBranchDelete: false,
        githubAllowForcePush: false,
        githubCiPollIntervalMs: this.settings.githubCiPollingInterval,
        githubCiMaxWaitMs: this.settings.githubCiMaxWait,
      },
    });
  }

  private observer(task: TaskRecord): AgentLoopObserver {
    return {
      phaseChanged: (phase) => {
        task.phase = phase as TaskPhase;
        this.notify("task.phaseChanged", { taskId: task.id, phase });
      },
      message: (content) =>
        this.notify("agent.message", { taskId: task.id, role: "assistant", content }),
      toolCallStarted: ({ id, name }) =>
        this.notify("agent.toolCallStarted", { taskId: task.id, toolCallId: id, toolName: name }),
      toolCallCompleted: ({ id, name, durationMs }) =>
        this.notify("agent.toolCallCompleted", {
          taskId: task.id,
          toolCallId: id,
          toolName: name,
          durationMs,
        }),
      toolCallFailed: ({ id, name, durationMs, error }) =>
        this.notify("agent.toolCallFailed", {
          taskId: task.id,
          toolCallId: id,
          toolName: name,
          durationMs,
          error,
        }),
    };
  }

  private async createResources(
    task: TaskRecord,
    context: Record<string, unknown> | undefined,
  ): Promise<{
    resources: SessionResources;
    agent: AgentLoop;
    prompt: string;
  }> {
    const config = await this.configFor(task.mode);
    const workspace = await LocalWorkspaceService.create({
      root: config.workspace,
      maxFileSizeBytes: config.maxFileSizeBytes,
      maxReadLines: config.maxReadLines,
      maxSearchResults: config.maxSearchResults,
      maxDirectoryDepth: config.maxDirectoryDepth,
      includeHiddenFiles: config.includeHiddenFiles,
      respectGitignore: config.respectGitignore,
      allowSensitiveFiles: config.allowSensitiveFiles,
    });
    const runner = createCommandRunner(config, this.sessionId ?? "runtime", async () => "pending", {
      beforeRun: (command: CommandSpec) =>
        this.notify("verification.stepStarted", {
          commandId: command.id,
          displayName: command.displayName ?? command.id,
        }),
      afterRun: (result: CommandResult) =>
        this.notify("verification.stepCompleted", {
          commandId: result.id,
          status: result.status,
        }),
    });
    const verifier = createVerifier(config, runner);
    const changes = await LocalChangeService.create({
      workspaceRoot: config.workspace,
      mode: config.accessMode,
      requireWriteConfirmation: true,
      allowFileDelete: config.allowFileDelete,
      allowFileMove: config.allowFileMove,
      allowSensitiveFileWrite: config.allowSensitiveFileWrite,
      allowSymlinkWrite: config.allowSymlinkWrite,
      defaultEol: config.defaultEol,
      checkpointRetention: config.checkpointRetention,
      checkpointMaxTotalBytes: config.checkpointMaxTotalBytes,
      limits: {
        maxChangedFiles: config.maxChangedFiles,
        maxCreatedFileBytes: config.maxCreatedFileBytes,
        maxTotalWriteBytes: config.maxTotalWriteBytes,
        maxPatchReplacements: config.maxPatchReplacements,
        maxChangeOperations: config.maxChangeOperations,
        maxDiffChars: config.maxDiffChars,
      },
      sessionId: this.sessionId ?? "runtime",
      confirmationProvider: async () => {
        if (!this.approvalOnce) return "pending";
        this.approvalOnce = false;
        return "approved";
      },
    });
    if (config.accessMode !== "readonly") await changes.createChangeSet({ task: task.title });
    const coordinator = new VerificationCoordinator(verifier, changes, {
      enabled: config.verificationEnabled,
      verifyAfterApply: config.verifyAfterApply,
      rollbackOnFailure: config.rollbackOnVerificationFailure,
      maxRepairAttempts: config.maxRepairAttempts,
      scope: config.verificationScope,
    });
    const registry = createRegistry(workspace, changes, runner, verifier, coordinator, config, {
      includeWorkspaceTools: this.workspace.trusted && this.workspace.activeRoot !== null,
      includeChangeTools: this.workspace.trusted && this.workspace.activeRoot !== null,
      allowApplyTools: task.mode === "agent",
    });
    if (config.remoteEnabled && this.remote !== undefined)
      registerRemoteTools(registry, this.remote);
    const resources = { config, changes, verifier, coordinator };
    const agent = new AgentLoop(new OllamaClient(config), registry, {
      defaultMaxSteps: config.maxSteps,
      maxModelCalls: config.maxModelCalls,
      maxFilesPerTask: config.maxFilesPerTask,
      maxContextChars: config.contextLength * 4,
      maxTaskDurationMs: config.maxTaskDurationMs,
      maxToolResultChars: config.maxToolResultChars,
      debug: config.debug,
      logger: (message) => this.log(message),
      changeSession: () => changes.getSessionSnapshot(),
      verificationSession: () => coordinator.snapshot(),
      commandStatistics: () => ({ ...runner.getStatistics(), ...verifier.getStatistics() }),
      observer: this.observer(task),
    });
    return { resources, agent, prompt: contextPrompt(task.title, task.mode, context) };
  }

  private async executeTask(
    task: TaskRecord,
    context: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (task.mode === "orchestrated") {
      await this.executeOrchestratedTask(task);
      return;
    }
    try {
      const prepared = await this.createResources(task, context);
      this.resources = prepared.resources;
      this.notify("task.progress", {
        taskId: task.id,
        message: "Runtime połączy się z lokalnym modelem.",
      });
      const result = await prepared.agent.run({
        task: prepared.prompt,
        signal: task.controller.signal,
      });
      task.answer = result.answer;
      task.finishReason = result.finishReason;
      task.phase = result.finishReason === "aborted" ? "cancelled" : (result.phase as TaskPhase);
      task.completedAt = new Date().toISOString();
      const preview = prepared.resources.changes.getLastPreview();
      if (preview !== undefined) {
        this.notify("changes.previewReady", preview);
        this.notify("changes.updated", {
          changes: await this.changeSnapshot(prepared.resources.changes),
        });
      }
      const report = prepared.resources.coordinator.snapshot().report;
      if (report !== undefined) this.notify("verification.completed", publicVerification(report));
      const event =
        task.phase === "cancelled"
          ? "task.cancelled"
          : result.finishReason === "error"
            ? "task.failed"
            : "task.completed";
      this.notify(event, publicTask(task));
    } catch (error: unknown) {
      const aborted = task.controller.signal.aborted;
      task.phase = aborted ? "cancelled" : "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.completedAt = new Date().toISOString();
      this.notify(aborted ? "task.cancelled" : "task.failed", publicTask(task));
      if (!aborted) this.notify("runtime.error", errorDetails(error));
    } finally {
      if (this.activeTask?.id === task.id) this.activeTask = undefined;
    }
  }

  private async executeOrchestratedTask(task: TaskRecord): Promise<void> {
    try {
      task.phase = "orchestration";
      this.notify("task.phaseChanged", { taskId: task.id, phase: task.phase });
      const session = await (
        await this.orchestrationService()
      ).createSession({
        task: task.title,
        mode: this.settings.orchestrationDefaultMode,
      });
      task.answer = `Utworzono sesję orkiestracji ${session.id}. Plan oczekuje na zatwierdzenie.`;
      task.finishReason = "completed";
      task.phase = "completed";
      task.completedAt = new Date().toISOString();
      this.notify("orchestration.approvalRequired", { sessionId: session.id, kind: "plan" });
      this.notify("task.completed", publicTask(task));
    } catch (error) {
      task.phase = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.completedAt = new Date().toISOString();
      this.notify("orchestration.failed", { taskId: task.id, error: task.error });
      this.notify("task.failed", publicTask(task));
    } finally {
      if (this.activeTask?.id === task.id) this.activeTask = undefined;
    }
  }

  private async startTask(payload: Record<string, unknown>): Promise<TaskSummary> {
    if (this.activeTask !== undefined)
      throw new RuntimeRequestError("RUNTIME_BUSY", "Runtime wykonuje już zadanie.");
    const mode = stringValue(payload.mode, "mode") as AgentMode;
    const context = payload.context === undefined ? undefined : asRecord(payload.context);
    this.ensureWorkspace(mode, context);
    const title = stringValue(payload.task ?? payload.message, "task");
    const task: TaskRecord = {
      id: randomUUID(),
      title: title.slice(0, 160),
      mode,
      phase: "queued",
      createdAt: new Date().toISOString(),
      controller: new AbortController(),
    };
    this.tasks.set(task.id, task);
    this.history.unshift(task);
    this.history.splice(MAX_HISTORY);
    this.activeTask = task;
    this.notify("task.created", publicTask(task));
    void this.executeTask(task, context);
    return publicTask(task);
  }

  private async changeSnapshot(changes: LocalChangeService): Promise<Record<string, unknown>> {
    const session = changes.getSessionSnapshot();
    const current = await changes.getCurrentChangeSet();
    return { ...session, operations: current.operations };
  }

  private requireChanges(): SessionResources {
    if (this.resources === undefined)
      throw new RuntimeRequestError("NO_ACTIVE_CHANGES", "Brak sesji zmian.");
    return this.resources;
  }

  private async remoteService(): Promise<RemoteRuntimeService> {
    if (this.remote === undefined) {
      const config = await this.configFor("agent");
      this.remote = new RemoteRuntimeService(config, this.sessionId ?? "runtime");
    }
    return this.remote;
  }

  private async orchestrationService(): Promise<OrchestrationRuntimeService> {
    if (!this.workspace.trusted || this.workspace.activeRoot === null) {
      throw new RuntimeRequestError(
        "WORKSPACE_UNTRUSTED",
        "Orkiestracja wymaga zaufanego workspace.",
      );
    }
    if (this.orchestration === undefined) {
      this.orchestration = await OrchestrationRuntimeService.create(
        await this.configFor("orchestrated"),
        (method, payload) => this.notify(method as NotificationName, payload),
      );
    }
    return this.orchestration;
  }

  private assertChangeSet(payload: Record<string, unknown>, resources: SessionResources): void {
    if (
      payload.changeSetId !== undefined &&
      payload.changeSetId !== resources.changes.getSessionSnapshot().changeSetId
    ) {
      throw new RuntimeRequestError(
        "CHANGESET_MISMATCH",
        "Identyfikator ChangeSet nie zgadza się z aktywną sesją.",
      );
    }
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    const payload = asRecord(request.params.payload);
    switch (request.method) {
      case "runtime.initialize":
        this.workspace = { ...this.workspace, trusted: payload.workspaceTrusted === true };
        return {
          runtimeName: "Local Code Agent Runtime",
          runtimeVersion: RUNTIME_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          capabilities: [...procedureNames],
        };
      case "runtime.shutdown":
        this.activeTask?.controller.abort();
        await this.orchestration?.cancelActive();
        this.remote?.disconnect();
        this.shuttingDown = true;
        return { ok: true };
      case "runtime.health":
        return {
          status:
            this.activeTask === undefined && this.orchestration?.hasActiveSession() !== true
              ? "ok"
              : "busy",
          uptimeMs: Math.max(0, (this.options.now ?? Date.now)() - this.startedAt),
          ...(this.activeTask === undefined ? {} : { activeTaskId: this.activeTask.id }),
        };
      case "runtime.getCapabilities":
        return { capabilities: [...procedureNames], protocolVersion: PROTOCOL_VERSION };
      case "workspace.set":
        if (this.activeTask !== undefined || this.orchestration?.hasActiveSession() === true)
          throw new RuntimeRequestError(
            "RUNTIME_BUSY",
            "Nie można zmienić workspace podczas zadania.",
          );
        this.workspace = request.params.payload as WorkspaceInfo;
        this.resources = undefined;
        this.remote?.disconnect();
        this.remote = undefined;
        this.orchestration = undefined;
        return this.workspace;
      case "workspace.getInfo":
        return this.workspace;
      case "task.start":
        return this.startTask(payload);
      case "agent.sendMessage":
        return this.startTask({ ...payload, task: payload.message });
      case "task.cancel": {
        const task = this.tasks.get(stringValue(payload.taskId, "taskId"));
        if (task === undefined)
          throw new RuntimeRequestError("TASK_NOT_FOUND", "Nie znaleziono zadania.");
        task.controller.abort();
        return { ok: true };
      }
      case "task.get": {
        const task = this.tasks.get(stringValue(payload.taskId, "taskId"));
        return { task: task === undefined ? null : publicTask(task) };
      }
      case "task.list":
        return {
          tasks: this.history.slice(0, Number(payload.limit ?? MAX_HISTORY)).map(publicTask),
        };
      case "agent.getState":
        return {
          state: this.activeTask === undefined ? "ready" : "busy",
          activeTask: this.activeTask === undefined ? null : publicTask(this.activeTask),
        };
      case "changes.getCurrent":
        return {
          changes:
            this.resources === undefined ? null : await this.changeSnapshot(this.resources.changes),
        };
      case "changes.preview": {
        const resources = this.requireChanges();
        const preview = await resources.changes.previewChangeSet();
        this.notify("changes.previewReady", preview);
        return preview;
      }
      case "changes.apply": {
        if (this.activeTask !== undefined)
          throw new RuntimeRequestError(
            "RUNTIME_BUSY",
            "Poczekaj na zakończenie zadania przed zastosowaniem zmian.",
          );
        const resources = this.requireChanges();
        this.assertChangeSet(payload, resources);
        this.approvalOnce = true;
        this.notify("task.progress", {
          taskId: this.history[0]?.id ?? "changes",
          message: "Stosowanie zatwierdzonego ChangeSet.",
        });
        await resources.coordinator.beforeApply();
        const result = await resources.changes.applyChangeSet();
        const report = await resources.coordinator.afterApply(result);
        this.notify("changes.applied", result);
        if (result.checkpointId !== undefined)
          this.notify("checkpoint.created", { checkpointId: result.checkpointId });
        if (report !== undefined) this.notify("verification.completed", publicVerification(report));
        return result;
      }
      case "changes.reject": {
        const resources = this.requireChanges();
        this.assertChangeSet(payload, resources);
        const changeSetId = resources.changes.getSessionSnapshot().changeSetId;
        await resources.changes.clearChangeSet();
        this.notify("changes.rejected", {
          changeSetId,
          ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
        });
        return { ok: true };
      }
      case "verification.run": {
        if (this.activeTask !== undefined)
          throw new RuntimeRequestError("RUNTIME_BUSY", "Runtime wykonuje już zadanie.");
        const resources = this.requireChanges();
        this.notify(
          "verification.started",
          typeof payload.reason === "string" ? { reason: payload.reason } : {},
        );
        const current = await resources.changes.getCurrentChangeSet();
        const report = await resources.verifier.verify({
          scope:
            (payload.scope as AgentConfig["verificationScope"] | undefined) ??
            resources.config.verificationScope,
          reason:
            typeof payload.reason === "string"
              ? payload.reason
              : "Weryfikacja uruchomiona z VS Code.",
          changedFiles: current.operations
            .flatMap((operation) =>
              operation.type === "move_file"
                ? [operation.sourcePath ?? "", operation.destinationPath ?? ""]
                : [operation.path ?? ""],
            )
            .filter(Boolean),
        });
        const result = publicVerification(report);
        this.notify("verification.completed", result);
        return result;
      }
      case "verification.get": {
        const report = this.resources?.verifier.getReport(
          typeof payload.verificationId === "string" ? payload.verificationId : undefined,
        );
        return { verification: report === undefined ? null : publicVerification(report) };
      }
      case "checkpoints.list":
        return {
          checkpoints:
            this.resources === undefined ? [] : await this.resources.changes.listCheckpoints(),
        };
      case "checkpoints.restore": {
        if (this.activeTask !== undefined)
          throw new RuntimeRequestError("RUNTIME_BUSY", "Runtime wykonuje już zadanie.");
        const resources = this.requireChanges();
        this.approvalOnce = true;
        const checkpointId = stringValue(payload.checkpointId, "checkpointId");
        const result = await resources.changes.restoreCheckpoint(
          checkpointId,
          typeof payload.reason === "string" ? payload.reason : "Restore zatwierdzony w VS Code.",
        );
        this.notify("checkpoint.restored", { checkpointId });
        this.notify("checkpoint.created", {
          checkpointId: result.safetyCheckpointId,
          reason: "Checkpoint bezpieczeństwa przed restore.",
        });
        return result;
      }
      case "remote.getStatus":
        return (await this.remoteService()).status();
      case "remote.authenticate": {
        const remote = await this.remoteService();
        const mode = stringValue(payload.mode, "mode");
        const user =
          mode === "vscode"
            ? await remote.authenticateWithToken(stringValue(payload.token, "token"), "vscode")
            : await remote.authenticateWithEnvironment();
        this.notify("remote.authenticationChanged", {
          authenticated: true,
          user: { login: user.login, ...(user.name === undefined ? {} : { name: user.name }) },
        });
        return { user };
      }
      case "remote.disconnect":
        this.remote?.disconnect();
        this.remote = undefined;
        this.notify("remote.authenticationChanged", { authenticated: false });
        return { ok: true };
      case "remote.getRepository": {
        const repository = await (
          await this.remoteService()
        ).detectRepository(typeof payload.remoteName === "string" ? payload.remoteName : undefined);
        return { repository };
      }
      case "remote.verifyRepository": {
        const verified = await (
          await this.remoteService()
        ).verifyRepository(typeof payload.remoteName === "string" ? payload.remoteName : undefined);
        this.notify("remote.repositoryVerified", {
          repository: verified.repository,
          user: verified.user,
        });
        this.notify("remote.permissionChanged", { permissions: verified.permissions });
        return verified;
      }
      case "remote.getPermissions": {
        const verified = await (
          await this.remoteService()
        ).verifyRepository(typeof payload.remoteName === "string" ? payload.remoteName : undefined);
        return { permissions: verified.permissions };
      }
      case "remote.getRateLimit": {
        const rateLimit = await (await this.remoteService()).rateLimit();
        this.notify("remote.rateLimitChanged", rateLimit);
        return rateLimit;
      }
      case "remote.publishTaskBranch": {
        const remote = await this.remoteService();
        const taskId = stringValue(payload.taskId, "taskId");
        if (typeof payload.approvalId !== "string") {
          const prepared = await remote.preparePublish(
            taskId,
            typeof payload.remoteName === "string" ? payload.remoteName : undefined,
          );
          this.preparedPublishes.set(prepared.approvalId, prepared);
          const result = {
            requestId: prepared.approvalId,
            taskId,
            repository: `${prepared.repository.owner}/${prepared.repository.repository}`,
            remote: prepared.repository.remoteName,
            branch: prepared.branch,
            commits: prepared.commits,
            requiresApproval: true,
          };
          this.notify("remote.publishApprovalRequired", result);
          return result;
        }
        const prepared = this.preparedPublishes.get(payload.approvalId);
        if (prepared === undefined || prepared.taskId !== taskId)
          throw new RuntimeRequestError("INVALID_REQUEST", "Nie znaleziono przygotowanego push.");
        this.preparedPublishes.delete(payload.approvalId);
        const manifest = await remote.executePublish(prepared, payload.approved === true);
        const result = manifest.remote?.publishedBranch ?? {};
        this.notify("remote.branchPublished", result);
        return result;
      }
      case "remote.getPublishedBranch":
        return (await this.remoteService()).getPublishedBranch(
          stringValue(payload.taskId, "taskId"),
        );
      case "pullRequest.createDraft": {
        const remote = await this.remoteService();
        const taskId = stringValue(payload.taskId, "taskId");
        if (typeof payload.approvalId !== "string") {
          const prepared = await remote.prepareCreatePullRequest(taskId, {
            ...(typeof payload.title === "string" ? { title: payload.title } : {}),
            ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
            ...(typeof payload.issueNumber === "number"
              ? { issueNumber: payload.issueNumber }
              : {}),
            ...(Array.isArray(payload.labels) ? { labels: payload.labels.map(String) } : {}),
          });
          this.preparedPullRequests.set(prepared.approvalId, prepared);
          const result = {
            requestId: prepared.approvalId,
            taskId,
            repository: `${prepared.repository.owner}/${prepared.repository.repository}`,
            head: prepared.manifest.branch,
            base: prepared.manifest.baseBranch,
            draft: true,
            title: prepared.title,
            body: prepared.body,
            requiresApproval: true,
          };
          this.notify("pullRequest.createApprovalRequired", result);
          return result;
        }
        const prepared = this.preparedPullRequests.get(payload.approvalId);
        if (prepared === undefined || prepared.manifest.id !== taskId)
          throw new RuntimeRequestError("INVALID_REQUEST", "Nie znaleziono przygotowanego PR.");
        this.preparedPullRequests.delete(payload.approvalId);
        const pull = await remote.executeCreatePullRequest(prepared, payload.approved === true);
        this.notify("pullRequest.created", pull);
        return pull;
      }
      case "pullRequest.get":
        return (await this.remoteService()).getPullRequest(stringValue(payload.taskId, "taskId"));
      case "pullRequest.openInBrowser": {
        const pull = await (
          await this.remoteService()
        ).getPullRequest(stringValue(payload.taskId, "taskId"));
        return { url: pull.url };
      }
      case "pullRequest.listChecks": {
        const checks = await (
          await this.remoteService()
        ).listChecks(stringValue(payload.taskId, "taskId"));
        this.notify("pullRequest.checksChanged", { checks });
        return { checks };
      }
      case "pullRequest.watchChecks": {
        const remote = await this.remoteService();
        const taskId = stringValue(payload.taskId, "taskId");
        const checks =
          payload.mode === "until_complete"
            ? await remote.watchChecks(taskId)
            : await remote.listChecks(taskId);
        this.notify("pullRequest.checksChanged", { checks });
        return { checks };
      }
      case "pullRequest.cancelWatch":
        this.remote?.cancelWatches();
        return { ok: true };
      case "pullRequest.getCheckLogs": {
        const result = await (
          await this.remoteService()
        ).getCheckLogs(
          stringValue(payload.taskId, "taskId"),
          stringValue(payload.checkId, "checkId"),
        );
        if (result.promptInjectionWarning === true) {
          this.notify("remote.securityWarning", {
            code: "REMOTE_PROMPT_INJECTION_WARNING",
            message: "Log CI zawiera podejrzaną instrukcję i pozostaje niezaufany.",
            critical: true,
          });
        }
        return result;
      }
      case "pullRequest.analyzeCheck": {
        const analysis = await (
          await this.remoteService()
        ).analyzeCheck(
          stringValue(payload.taskId, "taskId"),
          stringValue(payload.checkId, "checkId"),
        );
        this.notify("pullRequest.ciAnalysisReady", analysis);
        return analysis;
      }
      case "pullRequest.listReviews": {
        const reviews = await (
          await this.remoteService()
        ).listReviews(stringValue(payload.taskId, "taskId"));
        if (reviews.some((review) => Array.isArray(review.securityWarnings))) {
          this.notify("remote.securityWarning", {
            code: "REMOTE_PROMPT_INJECTION_WARNING",
            message: "Review lub komentarz PR zawiera podejrzaną instrukcję.",
            critical: true,
          });
        }
        return { reviews };
      }
      case "pullRequest.listThreads": {
        const threads = await (
          await this.remoteService()
        ).listReviewThreads(stringValue(payload.taskId, "taskId"));
        if (
          threads.some(
            (thread) =>
              thread.securityWarnings?.includes("REMOTE_PROMPT_INJECTION_WARNING") === true,
          )
        ) {
          this.notify("remote.securityWarning", {
            code: "REMOTE_PROMPT_INJECTION_WARNING",
            message: "Review zawiera podejrzaną instrukcję i pozostaje niezaufane.",
            critical: true,
          });
        }
        this.notify("pullRequest.reviewThreadsChanged", { threads });
        return { threads };
      }
      case "pullRequest.getThread": {
        const threads = await (
          await this.remoteService()
        ).listReviewThreads(stringValue(payload.taskId, "taskId"));
        const thread = threads.find(
          (item) => item.id === stringValue(payload.threadId, "threadId"),
        );
        if (thread === undefined)
          throw new RuntimeRequestError("INVALID_REQUEST", "Nie znaleziono wątku review.");
        return thread;
      }
      case "pullRequest.replyToThread": {
        const remote = await this.remoteService();
        const taskId = stringValue(payload.taskId, "taskId");
        const threadId = stringValue(payload.threadId, "threadId");
        const body = stringValue(payload.body, "body");
        const commitSha = stringValue(payload.commitSha, "commitSha");
        if (typeof payload.approvalId !== "string") {
          const prepared = await remote.prepareReviewReply(taskId, threadId, body, commitSha);
          const value = { taskId, threadId, body, commitSha, approvalId: prepared.approvalId };
          this.preparedReplies.set(prepared.approvalId, value);
          const result = {
            requestId: prepared.approvalId,
            taskId,
            threadId,
            body,
            commitSha,
            requiresApproval: true,
          };
          this.notify("pullRequest.reviewReplyApprovalRequired", result);
          return result;
        }
        const prepared = this.preparedReplies.get(payload.approvalId);
        if (prepared === undefined || prepared.taskId !== taskId || prepared.threadId !== threadId)
          throw new RuntimeRequestError(
            "INVALID_REQUEST",
            "Nie znaleziono przygotowanej odpowiedzi.",
          );
        this.preparedReplies.delete(payload.approvalId);
        const comment = await remote.executeReviewReply({
          ...prepared,
          approved: payload.approved === true,
        });
        this.notify("pullRequest.reviewReplySent", comment);
        return comment;
      }
      case "pullRequest.resolveThread": {
        const remote = await this.remoteService();
        const taskId = stringValue(payload.taskId, "taskId");
        const threadId = stringValue(payload.threadId, "threadId");
        if (typeof payload.approvalId !== "string") {
          const prepared = await remote.prepareResolveThread(taskId, threadId);
          const value = { taskId, threadId, approvalId: prepared.approvalId };
          this.preparedResolutions.set(prepared.approvalId, value);
          const result = {
            requestId: prepared.approvalId,
            taskId,
            threadId,
            requiresApproval: true,
          };
          this.notify("pullRequest.resolveApprovalRequired", result);
          return result;
        }
        const prepared = this.preparedResolutions.get(payload.approvalId);
        if (prepared === undefined || prepared.taskId !== taskId || prepared.threadId !== threadId)
          throw new RuntimeRequestError(
            "INVALID_REQUEST",
            "Nie znaleziono przygotowanego rozwiązania wątku.",
          );
        this.preparedResolutions.delete(payload.approvalId);
        await remote.executeResolveThread({ ...prepared, approved: payload.approved === true });
        this.notify("pullRequest.threadResolved", { taskId, threadId });
        return { ok: true };
      }
      case "pullRequest.update":
      case "pullRequest.linkIssue":
      case "pullRequest.setLabels": {
        const remote = await this.remoteService();
        const taskId = stringValue(payload.taskId, "taskId");
        if (typeof payload.approvalId !== "string") {
          const prepared = await remote.prepareUpdatePullRequest(taskId, {
            ...(request.method === "pullRequest.update" && typeof payload.title === "string"
              ? { title: payload.title }
              : {}),
            ...(request.method === "pullRequest.update" && typeof payload.summary === "string"
              ? { summary: payload.summary }
              : {}),
            ...(request.method === "pullRequest.linkIssue" &&
            typeof payload.issueNumber === "number"
              ? {
                  issueNumber: payload.issueNumber,
                  issueKeyword: payload.keyword as "Closes" | "Fixes" | "Refs",
                }
              : {}),
            ...(Array.isArray(payload.labels) ? { labels: payload.labels.map(String) } : {}),
          });
          this.preparedPullRequestUpdates.set(prepared.approvalId, prepared);
          return {
            requestId: prepared.approvalId,
            taskId,
            diff: prepared.diff,
            requiresApproval: true,
          };
        }
        const prepared = this.preparedPullRequestUpdates.get(payload.approvalId);
        if (prepared === undefined || prepared.manifest.id !== taskId) {
          throw new RuntimeRequestError(
            "INVALID_REQUEST",
            "Nie znaleziono przygotowanej aktualizacji PR.",
          );
        }
        this.preparedPullRequestUpdates.delete(payload.approvalId);
        const pull = await remote.executeUpdatePullRequest(prepared, payload.approved === true);
        this.notify("pullRequest.updated", pull);
        return pull;
      }
      case "orchestration.getStatus":
        return (await this.orchestrationService()).stats();
      case "orchestration.create": {
        const service = await this.orchestrationService();
        const session = await service.createSession({
          task: stringValue(payload.task, "task"),
          mode: payload.mode as "analysis" | "implementation" | "autonomous",
          ...(Array.isArray(payload.files) ? { files: payload.files.map(String) } : {}),
          ...(typeof payload.includePerformance === "boolean"
            ? { includePerformance: payload.includePerformance }
            : {}),
          ...(typeof payload.includeDocumentation === "boolean"
            ? { includeDocumentation: payload.includeDocumentation }
            : {}),
        });
        return session;
      }
      case "orchestration.get":
        return (await this.orchestrationService()).get(stringValue(payload.sessionId, "sessionId"));
      case "orchestration.list":
        return { sessions: await (await this.orchestrationService()).list() };
      case "orchestration.cancel": {
        const session = await (
          await this.orchestrationService()
        ).cancel(stringValue(payload.sessionId, "sessionId"));
        return session;
      }
      case "orchestration.resume": {
        const sessionId = stringValue(payload.sessionId, "sessionId");
        const service = await this.orchestrationService();
        const session = await service.resume(sessionId);
        void service
          .run(sessionId)
          .catch((error: unknown) => this.log(errorDetails(error).message));
        return session;
      }
      case "orchestration.getPlan":
        return {
          plans: await (
            await this.orchestrationService()
          ).plan(stringValue(payload.sessionId, "sessionId")),
        };
      case "orchestration.approvePlan": {
        const sessionId = stringValue(payload.sessionId, "sessionId");
        const service = await this.orchestrationService();
        const session = await service.approvePlan(sessionId, "user_ui");
        void service
          .run(sessionId)
          .catch((error: unknown) => this.log(errorDetails(error).message));
        return session;
      }
      case "orchestration.rejectPlan":
        return (await this.orchestrationService()).rejectPlan(
          stringValue(payload.sessionId, "sessionId"),
        );
      case "orchestration.getTaskGraph":
        return (await this.orchestrationService()).graph(
          stringValue(payload.sessionId, "sessionId"),
        );
      case "orchestration.getNode":
        return (await this.orchestrationService()).node(
          stringValue(payload.sessionId, "sessionId"),
          stringValue(payload.nodeId, "nodeId"),
        );
      case "orchestration.retryNode":
        return (await this.orchestrationService()).retryNode(
          stringValue(payload.sessionId, "sessionId"),
          stringValue(payload.nodeId, "nodeId"),
        );
      case "orchestration.cancelNode":
        return (await this.orchestrationService()).cancelNode(
          stringValue(payload.sessionId, "sessionId"),
          stringValue(payload.nodeId, "nodeId"),
        );
      case "orchestration.getAgents":
        return {
          agents: await (
            await this.orchestrationService()
          ).agents(stringValue(payload.sessionId, "sessionId")),
        };
      case "orchestration.getAgent": {
        const agents = await (
          await this.orchestrationService()
        ).agents(stringValue(payload.sessionId, "sessionId"));
        const agent = agents.find((item) => item.id === stringValue(payload.agentId, "agentId"));
        if (agent === undefined)
          throw new RuntimeRequestError("INVALID_REQUEST", "Nie znaleziono agenta.");
        return agent;
      }
      case "orchestration.getArtifacts":
        return {
          artifacts: await (
            await this.orchestrationService()
          ).artifacts(stringValue(payload.sessionId, "sessionId")),
        };
      case "orchestration.getConflicts":
        return {
          conflicts: await (
            await this.orchestrationService()
          ).conflicts(stringValue(payload.sessionId, "sessionId")),
        };
      case "orchestration.getReview":
        return {
          review: await (
            await this.orchestrationService()
          ).review(stringValue(payload.sessionId, "sessionId")),
        };
      case "orchestration.approveResult": {
        const session = await (
          await this.orchestrationService()
        ).approveResult(stringValue(payload.sessionId, "sessionId"), "user_ui");
        return session;
      }
      case "orchestration.rejectResult":
        return (await this.orchestrationService()).rejectResult(
          stringValue(payload.sessionId, "sessionId"),
        );
      case "settings.update":
        if (this.activeTask !== undefined || this.orchestration?.hasActiveSession() === true)
          throw new RuntimeRequestError(
            "RUNTIME_BUSY",
            "Nie można zmienić ustawień podczas zadania.",
          );
        this.settings = { ...this.settings, ...payload } as RuntimeSettings;
        this.remote?.disconnect();
        this.remote = undefined;
        this.orchestration = undefined;
        return this.settings;
      case "settings.get":
        return this.settings;
    }
  }

  private async handleLine(line: string): Promise<void> {
    let id: JsonRpcId | null = null;
    try {
      const raw = JSON.parse(line) as unknown;
      if (typeof raw === "object" && raw !== null && "id" in raw) {
        const candidate = (raw as { id?: unknown }).id;
        if (typeof candidate === "string" || typeof candidate === "number") id = candidate;
      }
      const request = parseRequest(raw);
      id = request.id;
      if (this.sessionId === undefined) this.sessionId = request.params.sessionId;
      assertSession(this.sessionId, request.params.sessionId);
      const result = await this.dispatch(request);
      this.result(request.id, request.method, result);
    } catch (error: unknown) {
      this.failure(id, error);
    }
  }

  public async start(): Promise<void> {
    if (this.sessionId !== undefined) {
      this.notify("runtime.ready", {
        runtimeVersion: RUNTIME_VERSION,
        protocolVersion: PROTOCOL_VERSION,
      });
    }
    const lines = createInterface({ input: this.options.input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim() === "") continue;
      await this.handleLine(line);
      if (this.shuttingDown) {
        lines.close();
        break;
      }
    }
  }
}

export function runtimeSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.AGENT_RUNTIME_SESSION_ID?.trim();
  return value === "" ? undefined : value;
}

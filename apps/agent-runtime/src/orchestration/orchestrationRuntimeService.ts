import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AgentOrchestrator,
  type CentralToolDispatchContext,
  type CreateOrchestrationRequest,
  type OrchestrationFinalReport,
  type OrchestrationSessionManifest,
} from "@local-code-agent/agent-orchestrator";
import { LocalChangeService, type ChangeSet } from "@local-code-agent/change-engine";
import { LocalWorkspaceService } from "@local-code-agent/workspace";

import { createCommandRunner, createRegistry, createVerifier } from "../cli.js";
import type { AgentConfig } from "../config.js";
import { VerificationCoordinator } from "../verificationCoordinator.js";
import type { ToolRegistry } from "../tools/toolRegistry.js";
import { OllamaSpecialistRunner } from "./ollamaSpecialistRunner.js";

interface SessionTools {
  registry: ToolRegistry;
  changes: LocalChangeService;
  sourceChangeSetId: string;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Argumenty narzędzia muszą być obiektem.");
  return value as Record<string, unknown>;
}

function orchestrationConfig(config: AgentConfig) {
  return {
    enabled: config.orchestrationEnabled,
    modelDefault: config.orchestrationModelDefault,
    roleModels: {
      planner: config.orchestrationModelPlanner,
      repository_explorer: config.orchestrationModelExplorer,
      architecture: config.orchestrationModelArchitect,
      implementation: config.orchestrationModelImplementation,
      test: config.orchestrationModelTest,
      review: config.orchestrationModelReview,
      security: config.orchestrationModelSecurity,
      performance: config.orchestrationModelPerformance,
      documentation: config.orchestrationModelDocumentation,
    },
    maxAgents: config.orchestrationMaxAgents,
    maxParallelAgents: config.orchestrationMaxParallelAgents,
    maxSubtasks: config.orchestrationMaxSubtasks,
    maxDepth: config.orchestrationMaxDepth,
    maxTotalSteps: config.orchestrationMaxTotalSteps,
    maxTotalToolCalls: config.orchestrationMaxTotalToolCalls,
    maxTotalCommands: config.orchestrationMaxTotalCommands,
    maxTotalDurationMs: config.orchestrationMaxTotalDurationMs,
    maxTotalContextTokens: config.orchestrationMaxTotalContextTokens,
    maxAgentContextTokens: config.orchestrationMaxAgentContextTokens,
    maxAgentOutputChars: config.orchestrationMaxAgentOutputChars,
    requirePlanApproval: config.orchestrationRequirePlanApproval,
    requireFinalApproval: config.orchestrationRequireFinalApproval,
    requireReview: config.orchestrationRequireReview,
    requireSecurityReview: config.orchestrationRequireSecurityReview,
    allowParallelWrites: false as const,
    consensusThreshold: config.orchestrationConsensusThreshold,
    stopOnCriticalSecurity: config.orchestrationStopOnCriticalSecurity,
    maxReplans: config.orchestrationMaxReplans,
    maxTaskRetries: config.orchestrationMaxTaskRetries,
  };
}

export class OrchestrationRuntimeService {
  private readonly tools = new Map<string, Promise<SessionTools>>();
  private readonly rootDirectory: string;
  private readonly orchestrator: AgentOrchestrator;

  private constructor(
    private readonly config: AgentConfig,
    private readonly workspace: LocalWorkspaceService,
    repositoryContext: {
      workspaceLabel: string;
      files: string[];
      symbols: string[];
      diagnostics: string[];
    },
    notify?: (method: string, payload: Record<string, unknown>) => void,
  ) {
    this.rootDirectory = join(config.workspace, ".agent", "orchestration");
    this.orchestrator = new AgentOrchestrator({
      runner: new OllamaSpecialistRunner(config),
      rootDirectory: this.rootDirectory,
      dispatcher: (name, arguments_, context) => this.dispatch(name, arguments_, context),
      repositoryContext,
      config: orchestrationConfig(config),
      ...(notify === undefined
        ? {}
        : { onEvent: (event) => notify(`orchestration.${event.type}`, event.payload) }),
    });
  }

  public static async create(
    config: AgentConfig,
    notify?: (method: string, payload: Record<string, unknown>) => void,
  ): Promise<OrchestrationRuntimeService> {
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
    const info = await workspace.getWorkspaceInfo();
    const files = await workspace.listFiles({
      path: ".",
      recursive: false,
      maxDepth: 1,
      includeDirectories: false,
    });
    return new OrchestrationRuntimeService(
      config,
      workspace,
      {
        workspaceLabel: info.name,
        files: files.entries.map((entry) => entry.path),
        symbols: [],
        diagnostics: [],
      },
      notify,
    );
  }

  public createSession(request: CreateOrchestrationRequest): Promise<OrchestrationSessionManifest> {
    return this.orchestrator.create(request);
  }

  public async list(): Promise<OrchestrationSessionManifest[]> {
    await this.loadPersisted();
    return this.orchestrator.list();
  }

  public async get(sessionId: string): Promise<OrchestrationSessionManifest> {
    await this.ensureLoaded(sessionId);
    return this.orchestrator.get(sessionId);
  }

  public async approvePlanAndRun(
    sessionId: string,
    actor: "user_cli" | "user_ui",
  ): Promise<OrchestrationFinalReport> {
    await this.approvePlan(sessionId, actor);
    return this.run(sessionId);
  }

  public async approvePlan(
    sessionId: string,
    actor: "user_cli" | "user_ui",
  ): Promise<OrchestrationSessionManifest> {
    await this.ensureLoaded(sessionId);
    return this.orchestrator.approvePlan(sessionId, actor);
  }

  public async run(sessionId: string): Promise<OrchestrationFinalReport> {
    try {
      return await this.orchestrator.run(sessionId);
    } finally {
      await this.persistChangeSet(sessionId);
    }
  }

  public async approveResult(
    sessionId: string,
    actor: "user_cli" | "user_ui",
  ): Promise<OrchestrationSessionManifest> {
    await this.ensureLoaded(sessionId);
    const report = this.orchestrator.report(sessionId);
    if (report?.changes !== undefined) {
      const tools = await this.sessionTools(sessionId);
      const current = await tools.changes.getCurrentChangeSet();
      const preview = await tools.changes.previewChangeSet();
      if (
        tools.sourceChangeSetId !== report.changes.changeSetId ||
        current.operations.length === 0 ||
        !preview.canApply
      ) {
        throw new Error(
          "Raport implementacji nie wskazuje rzeczywistego, niepustego ChangeSetu tej sesji.",
        );
      }
    }
    return this.orchestrator.approveFinal(sessionId, actor);
  }

  public async rejectPlan(sessionId: string): Promise<OrchestrationSessionManifest> {
    await this.ensureLoaded(sessionId);
    return this.orchestrator.rejectPlan(sessionId);
  }

  public async rejectResult(sessionId: string): Promise<OrchestrationSessionManifest> {
    await this.ensureLoaded(sessionId);
    const session = this.orchestrator.get(sessionId);
    if (session.state === "awaiting_final_approval") await this.orchestrator.rejectFinal(sessionId);
    else if (session.state !== "security_stopped")
      throw new Error("Sesja nie oczekuje na decyzję o wyniku.");
    return this.orchestrator.replan(sessionId, "user_rejected_result");
  }

  public async cancel(sessionId: string): Promise<OrchestrationSessionManifest> {
    await this.ensureLoaded(sessionId);
    return this.orchestrator.cancel(sessionId);
  }

  public async resume(sessionId: string): Promise<OrchestrationSessionManifest> {
    await this.ensureLoaded(sessionId);
    return this.orchestrator.resume(sessionId);
  }

  public async resumeAndRun(sessionId: string): Promise<OrchestrationFinalReport> {
    await this.resume(sessionId);
    return this.run(sessionId);
  }

  public async plan(sessionId: string) {
    await this.ensureLoaded(sessionId);
    return this.orchestrator.getPlan(sessionId);
  }
  public async graph(sessionId: string) {
    await this.ensureLoaded(sessionId);
    return this.orchestrator.getTaskGraph(sessionId);
  }
  public async node(sessionId: string, nodeId: string) {
    await this.ensureLoaded(sessionId);
    return this.orchestrator.getNode(sessionId, nodeId);
  }
  public async agents(sessionId: string) {
    await this.ensureLoaded(sessionId);
    return this.orchestrator.getAgents(sessionId);
  }
  public async artifacts(sessionId: string) {
    await this.ensureLoaded(sessionId);
    return this.orchestrator.getArtifacts(sessionId);
  }
  public async conflicts(sessionId: string) {
    await this.ensureLoaded(sessionId);
    return this.orchestrator.getConflicts(sessionId);
  }
  public async review(sessionId: string) {
    await this.ensureLoaded(sessionId);
    return this.orchestrator.report(sessionId);
  }
  public async retryNode(sessionId: string, nodeId: string) {
    await this.ensureLoaded(sessionId);
    return this.orchestrator.retryNode(sessionId, nodeId);
  }
  public async cancelNode(sessionId: string, nodeId: string) {
    await this.ensureLoaded(sessionId);
    return this.orchestrator.cancelNode(sessionId, nodeId);
  }
  public stats() {
    return this.orchestrator.stats();
  }

  public hasActiveSession(): boolean {
    return this.orchestrator.list().some((session) => session.state === "running");
  }

  public async cancelActive(): Promise<void> {
    await Promise.all(
      this.orchestrator
        .list()
        .filter((session) => session.state === "running")
        .map((session) => this.orchestrator.cancel(session.id)),
    );
  }

  private async ensureLoaded(sessionId: string): Promise<void> {
    try {
      this.orchestrator.get(sessionId);
    } catch {
      await this.orchestrator.recover(sessionId);
    }
  }

  private async loadPersisted(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.rootDirectory, { withFileTypes: true });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.ensureLoaded(entry.name)),
    );
  }

  private async dispatch(
    name: string,
    arguments_: unknown,
    context: CentralToolDispatchContext,
  ): Promise<unknown> {
    const args = record(arguments_);
    if (name === "read_file") {
      return this.workspace.readFile({ path: String(args.path) });
    }
    if (name === "search_repository") {
      return this.workspace.searchText({
        query: String(args.query),
        ...(typeof args.path === "string" ? { path: args.path } : {}),
      });
    }
    const aliases: Record<string, string> = {
      get_change_preview: "preview_changes",
      prepare_create_file: "create_file",
      prepare_delete_file: "delete_file",
      prepare_move_file: "move_file",
    };
    const sessionTools = await this.sessionTools(context.sessionId);
    return sessionTools.registry.execute(aliases[name] ?? name, args);
  }

  private sessionTools(sessionId: string): Promise<SessionTools> {
    let pending = this.tools.get(sessionId);
    if (pending !== undefined) return pending;
    pending = this.createSessionTools(sessionId);
    this.tools.set(sessionId, pending);
    return pending;
  }

  private async createSessionTools(sessionId: string): Promise<SessionTools> {
    const runner = createCommandRunner(this.config, sessionId, async () => "pending");
    const verifier = createVerifier(this.config, runner);
    const changes = await LocalChangeService.create({
      workspaceRoot: this.config.workspace,
      mode: "preview",
      requireWriteConfirmation: true,
      allowFileDelete: this.config.allowFileDelete,
      allowFileMove: this.config.allowFileMove,
      allowSensitiveFileWrite: this.config.allowSensitiveFileWrite,
      allowSymlinkWrite: this.config.allowSymlinkWrite,
      defaultEol: this.config.defaultEol,
      checkpointRetention: this.config.checkpointRetention,
      checkpointMaxTotalBytes: this.config.checkpointMaxTotalBytes,
      limits: {
        maxChangedFiles: this.config.maxChangedFiles,
        maxCreatedFileBytes: this.config.maxCreatedFileBytes,
        maxTotalWriteBytes: this.config.maxTotalWriteBytes,
        maxPatchReplacements: this.config.maxPatchReplacements,
        maxChangeOperations: this.config.maxChangeOperations,
        maxDiffChars: this.config.maxDiffChars,
      },
      sessionId,
      confirmationProvider: async () => "pending",
    });
    let restored: ChangeSet | undefined;
    try {
      const candidate = JSON.parse(
        await readFile(join(this.rootDirectory, sessionId, "prepared-change-set.json"), "utf8"),
      ) as Partial<ChangeSet>;
      if (
        typeof candidate.id === "string" &&
        /^[0-9a-f-]{36}$/iu.test(candidate.id) &&
        Array.isArray(candidate.operations)
      ) {
        restored = candidate as ChangeSet;
      }
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    const created = await changes.createChangeSet({
      task: this.orchestrator.get(sessionId).taskSummary,
      ...(restored === undefined ? {} : { operations: restored.operations }),
    });
    const coordinator = new VerificationCoordinator(verifier, changes, {
      enabled: this.config.verificationEnabled,
      verifyAfterApply: false,
      rollbackOnFailure: false,
      maxRepairAttempts: this.config.maxRepairAttempts,
      scope: this.config.verificationScope,
    });
    const registry = createRegistry(
      this.workspace,
      changes,
      runner,
      verifier,
      coordinator,
      this.config,
      {
        includeWorkspaceTools: true,
        includeChangeTools: true,
        allowApplyTools: false,
      },
    );
    return { registry, changes, sourceChangeSetId: restored?.id ?? created.id };
  }

  private async persistChangeSet(sessionId: string): Promise<void> {
    const pending = this.tools.get(sessionId);
    if (pending === undefined) return;
    const tools = await pending;
    const current = await tools.changes.getCurrentChangeSet();
    if (current.operations.length === 0) return;
    const changeSet = await tools.changes.getChangeSet(current.id);
    if (changeSet === null) return;
    const directory = join(this.rootDirectory, sessionId);
    const path = join(directory, "prepared-change-set.json");
    const temporary = `${path}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(changeSet, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  }
}

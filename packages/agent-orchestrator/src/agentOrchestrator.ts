import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  SpecialistExecutionContext,
  SpecialistModelRunner,
  SpecialistRole,
  SpecialistTask,
} from "@local-code-agent/agent-specialists";
import { TaskGraphBuilder, type TaskGraphNodeDraft } from "@local-code-agent/task-graph";

import {
  AgentExecutionContextFactory,
  type CentralToolDispatcher,
} from "./agentExecutionContext.js";
import { AgentFactory, createDefaultAgentRegistry } from "./agentFactory.js";
import { AgentResultValidator } from "./agentResultValidator.js";
import { ConflictResolutionService } from "./conflictResolutionService.js";
import { ConsensusService } from "./consensusService.js";
import {
  AgentCreationLimitError,
  IndependentReviewFailedError,
  OrchestrationDisabledError,
  OrchestrationFinalApprovalRequiredError,
  OrchestrationSessionNotFoundError,
  OrchestrationSessionStateError,
  SecurityReviewBlockedError,
} from "./errors.js";
import { FileLeaseService } from "./fileLeaseService.js";
import { FinalSynthesisService } from "./finalSynthesisService.js";
import { OrchestrationAuditService } from "./orchestrationAuditService.js";
import { OrchestrationBudgetTracker } from "./orchestrationBudget.js";
import { DEFAULT_ORCHESTRATION_CONFIG, type OrchestrationConfig } from "./orchestrationConfig.js";
import { OrchestrationRecovery } from "./orchestrationRecovery.js";
import { OrchestrationScheduler, type SchedulerEvent } from "./orchestrationScheduler.js";
import { OrchestrationSession, type ApprovalActor } from "./orchestrationSession.js";
import { SharedArtifactStore } from "./sharedArtifactStore.js";
import type {
  OrchestrationBudget,
  OrchestrationFinalReport,
  OrchestrationMode,
  OrchestrationSessionManifest,
  OrchestrationStatistics,
} from "./orchestrationTypes.js";

export interface CreateOrchestrationRequest {
  task: string;
  mode?: OrchestrationMode;
  specialists?: SpecialistRole[];
  files?: string[];
  includePerformance?: boolean;
  includeDocumentation?: boolean;
}

export interface OrchestrationRuntimeEvent {
  type:
    | "created"
    | "planReady"
    | "planApproved"
    | "stateChanged"
    | "nodeStarted"
    | "nodeCompleted"
    | "nodeFailed"
    | "agentStarted"
    | "agentCompleted"
    | "agentFailed"
    | "artifactCreated"
    | "reviewReady"
    | "securityBlocked"
    | "completed"
    | "failed"
    | "cancelled";
  sessionId: string;
  payload: Record<string, unknown>;
}

function budgetFrom(config: OrchestrationConfig): OrchestrationBudget {
  return {
    maxAgents: config.maxAgents,
    maxParallelAgents: config.maxParallelAgents,
    maxSubtasks: config.maxSubtasks,
    maxDepth: config.maxDepth,
    maxTotalSteps: config.maxTotalSteps,
    maxTotalToolCalls: config.maxTotalToolCalls,
    maxTotalCommands: config.maxTotalCommands,
    maxTotalDurationMs: config.maxTotalDurationMs,
    maxTotalContextTokens: config.maxTotalContextTokens,
  };
}

function initialDrafts(request: CreateOrchestrationRequest): TaskGraphNodeDraft[] {
  const mode = request.mode ?? "analysis";
  const files = [...(request.files ?? [])];
  const drafts: TaskGraphNodeDraft[] = [
    {
      id: "planning",
      title: "Plan specjalistyczny",
      description: request.task,
      assignedRole: "planner",
      accessMode: "read_only",
      expectedOutputs: ["implementation_plan"],
      risk: "medium",
      priority: 100,
    },
    {
      id: "repository_analysis",
      title: "Analiza repozytorium",
      description: "Zbierz mapę repozytorium i dowody potrzebne do realizacji zadania.",
      assignedRole: "repository_explorer",
      dependencies: ["planning"],
      accessMode: "read_only",
      expectedOutputs: ["repository_map"],
      files,
      risk: "low",
      priority: 90,
    },
    {
      id: "architecture_analysis",
      title: "Analiza architektury",
      description: "Oceń granice komponentów, zależności i ryzyko planu.",
      assignedRole: "architecture",
      dependencies: ["repository_analysis"],
      accessMode: "read_only",
      expectedOutputs: ["architecture_report"],
      files,
      risk: "medium",
      priority: 80,
    },
  ];
  let terminal = "architecture_analysis";
  if (mode !== "analysis") {
    drafts.push({
      id: "implementation",
      title: "Przygotowanie zmian",
      description: request.task,
      assignedRole: "implementation",
      dependencies: [terminal],
      accessMode: "prepare_changes",
      expectedOutputs: ["change_proposal"],
      files,
      risk: "high",
      priority: 70,
    });
    drafts.push({
      id: "verification",
      title: "Testy i weryfikacja",
      description: "Przygotuj testy i zweryfikuj propozycję zmian.",
      assignedRole: "test",
      dependencies: ["implementation"],
      accessMode: "verification",
      expectedOutputs: ["test_plan", "verification_report"],
      files,
      risk: "high",
      priority: 60,
    });
    terminal = "verification";
  }
  if (
    request.includePerformance === true ||
    request.specialists?.includes("performance") === true
  ) {
    drafts.push({
      id: "performance_review",
      title: "Analiza wydajności",
      description: "Oceń wpływ wydajnościowy rozwiązania.",
      assignedRole: "performance",
      dependencies: [terminal],
      accessMode: "read_only",
      expectedOutputs: ["performance_report"],
      files,
      risk: "medium",
      priority: 50,
    });
  }
  if (
    (request.includeDocumentation === true ||
      request.specialists?.includes("documentation") === true) &&
    mode !== "analysis"
  ) {
    drafts.push({
      id: "documentation",
      title: "Plan dokumentacji",
      description: "Przygotuj propozycję aktualizacji dokumentacji.",
      assignedRole: "documentation",
      dependencies: [terminal],
      accessMode: "prepare_changes",
      expectedOutputs: ["documentation_plan"],
      files: files.filter((path) => path.endsWith(".md") || path.startsWith("docs/")),
      risk: "low",
      priority: 40,
    });
  }
  return drafts;
}

function emptyStatistics(): OrchestrationStatistics {
  return {
    orchestrationSessionsCreated: 0,
    orchestrationSessionsCompleted: 0,
    orchestrationSessionsFailed: 0,
    orchestrationSessionsCancelled: 0,
    specialistAgentsCreated: 0,
    specialistAgentsCompleted: 0,
    specialistAgentsFailed: 0,
    taskGraphNodesCreated: 0,
    taskGraphNodesCompleted: 0,
    taskGraphNodesFailed: 0,
    maxParallelAgentsObserved: 0,
    orchestrationReplans: 0,
    orchestrationRetries: 0,
    sharedArtifactsCreated: 0,
    agentConflictsDetected: 0,
    agentConflictsResolved: 0,
    independentReviewsCompleted: 0,
    securityReviewsCompleted: 0,
    securityBlocks: 0,
    orchestrationContextTokens: 0,
    orchestrationToolCalls: 0,
    orchestrationCommands: 0,
  };
}

export class AgentOrchestrator {
  private readonly config: OrchestrationConfig;
  private readonly sessions = new Map<string, OrchestrationSession>();
  private readonly reports = new Map<string, OrchestrationFinalReport>();
  private readonly artifacts: SharedArtifactStore;
  private readonly recovery: OrchestrationRecovery;
  private readonly audit: OrchestrationAuditService;
  private readonly statistics = emptyStatistics();
  private readonly runControllers = new Map<string, AbortController>();

  public constructor(
    private readonly dependencies: {
      runner: SpecialistModelRunner;
      rootDirectory: string;
      dispatcher: CentralToolDispatcher;
      repositoryContext: SpecialistExecutionContext["repositoryContext"];
      config?: Partial<OrchestrationConfig> & {
        roleModels?: Partial<Record<SpecialistRole, string>>;
      };
      onEvent?: (event: OrchestrationRuntimeEvent) => Promise<void> | void;
    },
  ) {
    this.config = {
      ...DEFAULT_ORCHESTRATION_CONFIG,
      ...dependencies.config,
      roleModels: {
        ...DEFAULT_ORCHESTRATION_CONFIG.roleModels,
        ...dependencies.config?.roleModels,
      },
      allowParallelWrites: false,
    };
    this.artifacts = new SharedArtifactStore(
      this.config.artifactMaxBytes,
      dependencies.rootDirectory,
    );
    this.recovery = new OrchestrationRecovery(dependencies.rootDirectory);
    this.audit = new OrchestrationAuditService(
      join(dependencies.rootDirectory, "..", "history", "orchestration.jsonl"),
    );
  }

  public async create(request: CreateOrchestrationRequest): Promise<OrchestrationSessionManifest> {
    if (!this.config.enabled) throw new OrchestrationDisabledError();
    const graph = new TaskGraphBuilder().build(initialDrafts(request), {
      requireReview: this.config.requireReview,
      requireSecurityReview: this.config.requireSecurityReview,
      maxNodes: this.config.maxSubtasks,
      maxDepth: this.config.maxDepth,
    });
    if (graph.list().length > this.config.maxAgents) {
      throw new AgentCreationLimitError(
        `Plan wymaga ${graph.list().length} agentów; limit wynosi ${this.config.maxAgents}.`,
      );
    }
    const requestedSpecialists = [...new Set(graph.list().map((node) => node.assignedRole))];
    const session = OrchestrationSession.create({
      taskSummary: request.task,
      mode: request.mode ?? "analysis",
      graph,
      budget: budgetFrom(this.config),
      requestedSpecialists,
    });
    session.transition("planning");
    await this.executePlanner(session);
    session.syncLatestPlanGraph();
    session.enterApprovalGate(this.config.requirePlanApproval);
    this.sessions.set(session.id(), session);
    this.statistics.orchestrationSessionsCreated += 1;
    this.statistics.taskGraphNodesCreated += graph.list().length;
    await this.audit.record({
      timestamp: new Date().toISOString(),
      sessionId: session.id(),
      action: "session_created",
      state: session.state(),
    });
    await this.recovery.persist(session);
    await this.emit("created", session.id(), {
      state: session.state(),
      mode: request.mode ?? "analysis",
    });
    await this.emit("planReady", session.id(), {
      state: session.state(),
      graphVersion: graph.snapshot().version,
    });
    return session.manifest();
  }

  public get(sessionId: string): OrchestrationSessionManifest {
    return this.session(sessionId).manifest();
  }

  public list(): OrchestrationSessionManifest[] {
    return [...this.sessions.values()].map((session) => session.manifest());
  }

  public report(sessionId: string): OrchestrationFinalReport | undefined {
    const report = this.reports.get(sessionId);
    return report === undefined ? undefined : structuredClone(report);
  }

  public getPlan(sessionId: string): OrchestrationSessionManifest["planVersions"] {
    return this.session(sessionId).manifest().planVersions;
  }

  public getTaskGraph(sessionId: string) {
    return this.session(sessionId).taskGraph().snapshot();
  }

  public getNode(sessionId: string, nodeId: string) {
    return this.session(sessionId).taskGraph().get(nodeId);
  }

  public getAgents(sessionId: string): OrchestrationSessionManifest["agents"] {
    return this.session(sessionId).manifest().agents;
  }

  public getArtifacts(sessionId: string) {
    this.session(sessionId);
    return this.artifacts.list(sessionId);
  }

  public getConflicts(sessionId: string): OrchestrationSessionManifest["conflicts"] {
    return this.session(sessionId).manifest().conflicts;
  }

  public async approvePlan(
    sessionId: string,
    actor: ApprovalActor,
  ): Promise<OrchestrationSessionManifest> {
    const session = this.session(sessionId);
    session.approvePlan(actor);
    await this.audit.record({
      timestamp: new Date().toISOString(),
      sessionId,
      action: "plan_approved",
      state: session.state(),
    });
    await this.recovery.persist(session);
    await this.emit("planApproved", sessionId, { state: session.state() });
    return session.manifest();
  }

  public async rejectPlan(sessionId: string): Promise<OrchestrationSessionManifest> {
    const session = this.session(sessionId);
    if (session.state() !== "awaiting_plan_approval") throw new OrchestrationSessionStateError();
    return this.cancel(sessionId);
  }

  public async run(sessionId: string): Promise<OrchestrationFinalReport> {
    const session = this.session(sessionId);
    if (session.state() !== "scheduled")
      throw new OrchestrationSessionStateError("Sesja musi mieć zatwierdzony plan.");
    session.transition("running");
    const runController = new AbortController();
    this.runControllers.set(sessionId, runController);
    const tracker = new OrchestrationBudgetTracker(
      session.manifest().budget,
      session.manifest().usage,
    );
    tracker.createSubtask(session.taskGraph().list().length);
    const factory = new AgentFactory(
      createDefaultAgentRegistry(),
      this.dependencies.runner,
      this.config,
      tracker,
    );
    const scheduler = new OrchestrationScheduler({
      agentFactory: factory,
      contextFactory: new AgentExecutionContextFactory(),
      resultValidator: new AgentResultValidator(),
      artifacts: this.artifacts,
      leases: new FileLeaseService(),
      budget: tracker,
      config: this.config,
      dispatcher: this.dependencies.dispatcher,
      repositoryContext: this.dependencies.repositoryContext,
      signal: runController.signal,
      onEvent: (event) => this.onSchedulerEvent(session, event),
    });
    let consensus: "approved" | "changes_required" | "security_blocked" = "approved";
    try {
      const results = await scheduler.execute(sessionId, session.taskGraph());
      for (const result of Object.values(results)) session.recordResult(result);
      const conflicts = new ConflictResolutionService().detect(
        Object.values(session.manifest().results),
      );
      session.setConflicts(conflicts);
      this.statistics.agentConflictsDetected += conflicts.length;
      const decision = new ConsensusService().evaluate(Object.values(session.manifest().results), {
        threshold: this.config.consensusThreshold,
        requireReview: this.config.requireReview,
        requireSecurityReview: this.config.requireSecurityReview,
      });
      consensus = conflicts.some((conflict) => conflict.resolution === "unresolved")
        ? "changes_required"
        : decision.outcome;
    } catch (error) {
      if (
        error instanceof SecurityReviewBlockedError ||
        (typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "SECURITY_REVIEW_BLOCKED")
      ) {
        consensus = "security_blocked";
        if (session.state() === "running") session.transition("security_stopped");
        this.statistics.securityBlocks += 1;
      } else if (
        error instanceof IndependentReviewFailedError ||
        (typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "INDEPENDENT_REVIEW_FAILED")
      ) {
        consensus = "changes_required";
      } else {
        if (runController.signal.aborted) {
          session.updateUsage(tracker.usage());
          await this.recovery.persist(session);
          this.runControllers.delete(sessionId);
          throw new OrchestrationSessionStateError("Sesja orkiestracji została anulowana.");
        }
        if (session.state() === "running") session.transition("failed");
        this.statistics.orchestrationSessionsFailed += 1;
        session.updateUsage(tracker.usage());
        await this.recovery.persist(session);
        await this.emit("failed", sessionId, {
          state: session.state(),
          errorCode:
            typeof error === "object" && error !== null && "code" in error
              ? String(error.code)
              : "ORCHESTRATION_FAILED",
        });
        this.runControllers.delete(sessionId);
        throw error;
      }
    }
    session.updateUsage(tracker.usage());
    const manifest = session.manifest();
    const report = new FinalSynthesisService().synthesize({
      sessionId,
      taskSummary: manifest.taskSummary,
      graph: session.taskGraph().snapshot(),
      results: manifest.results,
      artifacts: this.artifacts.list(sessionId),
      conflicts: manifest.conflicts,
      consensus,
      limitations: manifest.warnings,
    });
    this.reports.set(sessionId, report);
    if (session.state() === "running") session.transition("awaiting_final_approval");
    this.updateUsageStatistics(tracker);
    await this.recovery.persist(session);
    await this.recovery.persistReport(sessionId, report);
    await this.emit(
      report.status === "security_blocked" ? "securityBlocked" : "reviewReady",
      sessionId,
      { status: report.status, recommendation: report.recommendation },
    );
    this.runControllers.delete(sessionId);
    return structuredClone(report);
  }

  public async approveFinal(
    sessionId: string,
    actor: ApprovalActor,
  ): Promise<OrchestrationSessionManifest> {
    const session = this.session(sessionId);
    const report = this.reports.get(sessionId);
    if (report?.status !== "ready_for_approval" || report.recommendation !== "apply") {
      throw new OrchestrationFinalApprovalRequiredError(
        "Wynik ma nierozwiązane blokady i nie może zostać zatwierdzony.",
      );
    }
    session.approveFinal(actor);
    this.statistics.orchestrationSessionsCompleted += 1;
    await this.audit.record({
      timestamp: new Date().toISOString(),
      sessionId,
      action: "session_completed",
      state: session.state(),
    });
    await this.recovery.persist(session);
    await this.emit("completed", sessionId, { state: session.state() });
    return session.manifest();
  }

  public async rejectFinal(sessionId: string): Promise<OrchestrationSessionManifest> {
    const session = this.session(sessionId);
    if (session.state() !== "awaiting_final_approval") throw new OrchestrationSessionStateError();
    session.rejectResult();
    await this.recovery.persist(session);
    return session.manifest();
  }

  public async replan(sessionId: string, reason: string): Promise<OrchestrationSessionManifest> {
    const session = this.session(sessionId);
    if (session.manifest().usage.replans >= this.config.maxReplans) {
      throw new OrchestrationSessionStateError("Przekroczono limit ponownego planowania.");
    }
    const manifest = session.manifest();
    const graph = new TaskGraphBuilder().build(
      initialDrafts({ task: manifest.taskSummary, mode: manifest.mode }),
      {
        requireReview: this.config.requireReview,
        requireSecurityReview: this.config.requireSecurityReview,
        maxNodes: this.config.maxSubtasks,
        maxDepth: this.config.maxDepth,
      },
    );
    session.replacePlan(graph, reason, this.config.requirePlanApproval);
    this.statistics.orchestrationReplans += 1;
    await this.recovery.persist(session);
    return session.manifest();
  }

  public async retryNode(sessionId: string, nodeId: string): Promise<OrchestrationSessionManifest> {
    const session = this.session(sessionId);
    const node = session.taskGraph().get(nodeId);
    if (node.status !== "failed" && node.status !== "blocked")
      throw new OrchestrationSessionStateError();
    session.taskGraph().setStatus(nodeId, "ready");
    if (session.state() === "failed") session.requireManualResume();
    await this.recovery.persist(session);
    return session.manifest();
  }

  public async cancelNode(
    sessionId: string,
    nodeId: string,
  ): Promise<OrchestrationSessionManifest> {
    const session = this.session(sessionId);
    if (session.taskGraph().get(nodeId).status === "running") {
      throw new OrchestrationSessionStateError(
        "Aktywnego węzła nie można bezpiecznie odłączyć; anuluj całą sesję.",
      );
    }
    session.taskGraph().setStatus(nodeId, "cancelled");
    await this.recovery.persist(session);
    return session.manifest();
  }

  public async cancel(sessionId: string): Promise<OrchestrationSessionManifest> {
    const session = this.session(sessionId);
    this.runControllers.get(sessionId)?.abort();
    session.transition("cancelled");
    this.statistics.orchestrationSessionsCancelled += 1;
    await this.recovery.persist(session);
    await this.emit("cancelled", sessionId, { state: session.state() });
    return session.manifest();
  }

  public async recover(sessionId: string): Promise<OrchestrationSessionManifest> {
    const session = await this.recovery.load(sessionId);
    const manifest = session.manifest();
    const validator = new AgentResultValidator();
    for (const [taskId, result] of Object.entries(manifest.results)) {
      validator.validate(result, taskId, result.role);
    }
    const artifactDirectory = join(this.recovery.sessionDirectory(sessionId), "artifacts");
    try {
      const files = await readdir(artifactDirectory);
      const loaded = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map((file) => this.artifacts.load(join(artifactDirectory, file))),
      );
      if (loaded.some((artifact) => artifact.sessionId !== sessionId)) {
        throw new OrchestrationSessionStateError("Artefakt należy do innej sesji.");
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
    const report = await this.recovery.loadReport(sessionId);
    if (report !== undefined) this.reports.set(sessionId, report);
    this.sessions.set(sessionId, session);
    await this.recovery.persist(session);
    return session.manifest();
  }

  public async resume(sessionId: string): Promise<OrchestrationSessionManifest> {
    const session = this.session(sessionId);
    session.resume();
    await this.recovery.persist(session);
    return session.manifest();
  }

  public stats(): OrchestrationStatistics {
    return structuredClone(this.statistics);
  }

  private session(sessionId: string): OrchestrationSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined)
      throw new OrchestrationSessionNotFoundError(`Nie znaleziono sesji ${sessionId}.`);
    return session;
  }

  private async executePlanner(session: OrchestrationSession): Promise<void> {
    const node = session.taskGraph().get("planning");
    const tracker = new OrchestrationBudgetTracker(
      session.manifest().budget,
      session.manifest().usage,
    );
    const factory = new AgentFactory(
      createDefaultAgentRegistry(),
      this.dependencies.runner,
      this.config,
      tracker,
    );
    const created = await factory.create("planner", node.id, node.depth ?? 1);
    session.taskGraph().setStatus(node.id, "running");
    session.recordAgent({
      id: `${node.id}:planner`,
      taskId: node.id,
      role: "planner",
      model: created.model,
      status: "running",
      ...(created.warning === undefined ? {} : { warning: created.warning }),
    });
    const signal = AbortSignal.timeout(node.budget.maxDurationMs);
    const context = new AgentExecutionContextFactory().create({
      sessionId: session.id(),
      taskId: node.id,
      role: "planner",
      access: created.agent.access,
      model: created.model,
      artifacts: [],
      repositoryContext: this.dependencies.repositoryContext,
      allowedTools: ["read_file", "search_repository"],
      dispatcher: this.dependencies.dispatcher,
      signal,
    });
    const task: SpecialistTask = {
      id: node.id,
      sessionId: session.id(),
      title: node.title,
      description: node.description,
      role: "planner",
      accessMode: "read_only",
      files: [...(node.files ?? [])],
      requirements: [...(node.verification ?? [])],
      expectedArtifactTypes: [...node.expectedOutputs],
      depth: node.depth ?? 1,
      budget: {
        maxSteps: node.budget.maxSteps,
        maxToolCalls: node.budget.maxToolCalls,
        maxCommands: node.budget.maxCommands,
        maxContextTokens: node.budget.maxContextTokens,
        maxDurationMs: node.budget.maxDurationMs,
      },
    };
    try {
      const result = new AgentResultValidator().validate(
        await created.agent.execute(task, context),
        node.id,
        "planner",
      );
      if (result.status !== "completed") {
        throw new OrchestrationSessionStateError(`Planner zakończył się stanem ${result.status}.`);
      }
      const returned = new Set(result.artifacts.map((artifact) => artifact.type));
      if (
        node.expectedOutputs.some((type) => !returned.has(type)) ||
        result.artifacts.some(
          (artifact) => !node.expectedOutputs.some((type) => type === artifact.type),
        )
      ) {
        throw new OrchestrationSessionStateError("Planner nie zwrócił kompletnego planu.");
      }
      for (const draft of result.artifacts) {
        const artifact = await this.artifacts.create({
          sessionId: session.id(),
          producerTaskId: node.id,
          producerRole: "planner",
          type: draft.type as "implementation_plan",
          payload: draft.payload,
          ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }),
          warnings: draft.warnings,
        });
        session.recordArtifact(artifact);
        this.statistics.sharedArtifactsCreated += 1;
      }
      tracker.consume(result.usage ?? {});
      tracker.markCompleted();
      session.recordResult(result);
      session.recordAgent({
        id: `${node.id}:planner`,
        taskId: node.id,
        role: "planner",
        model: created.model,
        status: "completed",
      });
      session.taskGraph().setStatus(node.id, "completed");
      session.taskGraph().refreshReadiness();
      session.updateUsage(tracker.usage());
      this.statistics.specialistAgentsCreated += 1;
      this.statistics.specialistAgentsCompleted += 1;
      this.statistics.taskGraphNodesCompleted += 1;
    } catch (error) {
      tracker.markFailed();
      session.taskGraph().setStatus(node.id, "failed");
      session.updateUsage(tracker.usage());
      throw error;
    }
  }

  private async onSchedulerEvent(
    session: OrchestrationSession,
    event: SchedulerEvent,
  ): Promise<void> {
    const agentId = `${event.taskId}:${event.role}`;
    if (event.type === "agent_started") {
      session.recordAgent({
        id: agentId,
        taskId: event.taskId,
        role: event.role,
        model: this.config.roleModels[event.role],
        status: "running",
        ...(event.warning === undefined ? {} : { warning: event.warning }),
      });
      this.statistics.specialistAgentsCreated += 1;
    } else if (event.type === "agent_completed" && event.result !== undefined) {
      session.recordResult(event.result);
      session.recordAgent({
        id: agentId,
        taskId: event.taskId,
        role: event.role,
        model: this.config.roleModels[event.role],
        status: "completed",
      });
      this.statistics.specialistAgentsCompleted += 1;
      this.statistics.taskGraphNodesCompleted += 1;
      if (event.role === "review") this.statistics.independentReviewsCompleted += 1;
      if (event.role === "security") this.statistics.securityReviewsCompleted += 1;
    } else if (event.type === "artifact_created" && event.artifact !== undefined) {
      session.recordArtifact(event.artifact);
      this.statistics.sharedArtifactsCreated += 1;
    } else if (event.type === "node_failed") {
      session.recordAgent({
        id: agentId,
        taskId: event.taskId,
        role: event.role,
        model: this.config.roleModels[event.role],
        status: "failed",
      });
      this.statistics.specialistAgentsFailed += 1;
      this.statistics.taskGraphNodesFailed += 1;
    }
    await this.audit.record({
      timestamp: new Date().toISOString(),
      sessionId: session.id(),
      action: event.type,
      nodeId: event.taskId,
      role: event.role,
      state: session.state(),
    });
    const type =
      event.type === "agent_started"
        ? "agentStarted"
        : event.type === "agent_completed"
          ? "agentCompleted"
          : event.type === "artifact_created"
            ? "artifactCreated"
            : "nodeFailed";
    await this.emit(type, session.id(), {
      taskId: event.taskId,
      role: event.role,
      ...(event.warning === undefined ? {} : { warning: event.warning }),
    });
    if (event.type === "agent_started") {
      await this.emit("nodeStarted", session.id(), { taskId: event.taskId, role: event.role });
    } else if (event.type === "agent_completed") {
      await this.emit("nodeCompleted", session.id(), { taskId: event.taskId, role: event.role });
    } else if (event.type === "node_failed") {
      await this.emit("agentFailed", session.id(), { taskId: event.taskId, role: event.role });
    }
  }

  private async emit(
    type: OrchestrationRuntimeEvent["type"],
    sessionId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.dependencies.onEvent?.({ type, sessionId, payload: { sessionId, ...payload } });
  }

  private updateUsageStatistics(tracker: OrchestrationBudgetTracker): void {
    const usage = tracker.usage();
    this.statistics.maxParallelAgentsObserved = Math.max(
      this.statistics.maxParallelAgentsObserved,
      usage.maxParallelObserved,
    );
    this.statistics.orchestrationRetries += usage.retries;
    this.statistics.orchestrationReplans += usage.replans;
    this.statistics.orchestrationContextTokens += usage.estimatedContextTokens;
    this.statistics.orchestrationToolCalls += usage.totalToolCalls;
    this.statistics.orchestrationCommands += usage.totalCommands;
  }
}

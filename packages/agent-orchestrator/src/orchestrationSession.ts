import { randomUUID } from "node:crypto";

import type { SpecialistResult, SpecialistRole } from "@local-code-agent/agent-specialists";
import { TaskGraph, type TaskGraphSnapshot } from "@local-code-agent/task-graph";

import {
  OrchestrationFinalApprovalRequiredError,
  OrchestrationPlanApprovalRequiredError,
} from "./errors.js";
import { OrchestrationStateMachine } from "./orchestrationStateMachine.js";
import type {
  AgentConflict,
  OrchestrationBudget,
  OrchestrationMode,
  OrchestrationSessionManifest,
  OrchestrationState,
  OrchestrationUsage,
  SharedArtifact,
} from "./orchestrationTypes.js";

export type ApprovalActor = "user_cli" | "user_ui";

function emptyUsage(): OrchestrationUsage {
  return {
    agentsCreated: 0,
    agentsCompleted: 0,
    agentsFailed: 0,
    maxParallelObserved: 0,
    subtasksCreated: 0,
    totalSteps: 0,
    totalToolCalls: 0,
    totalCommands: 0,
    totalDurationMs: 0,
    estimatedContextTokens: 0,
    replans: 0,
    retries: 0,
  };
}

export class OrchestrationSession {
  private readonly stateMachine = new OrchestrationStateMachine();

  private constructor(
    private data: OrchestrationSessionManifest,
    private graph: TaskGraph,
  ) {}

  public static create(input: {
    taskSummary: string;
    mode: OrchestrationMode;
    graph: TaskGraph;
    budget: OrchestrationBudget;
    requestedSpecialists: SpecialistRole[];
  }): OrchestrationSession {
    const now = new Date().toISOString();
    const snapshot = input.graph.snapshot();
    return new OrchestrationSession(
      {
        id: randomUUID(),
        taskSummary: input.taskSummary,
        mode: input.mode,
        state: "created",
        createdAt: now,
        updatedAt: now,
        planVersions: [{ version: 1, createdAt: now, reason: "initial_plan", graph: snapshot }],
        budget: structuredClone(input.budget),
        usage: emptyUsage(),
        requestedSpecialists: [...input.requestedSpecialists],
        agents: [],
        results: {},
        artifactIds: [],
        conflicts: [],
        warnings: [],
        requiresManualResume: false,
      },
      input.graph,
    );
  }

  public static rehydrate(
    manifest: OrchestrationSessionManifest,
    graph: TaskGraphSnapshot,
  ): OrchestrationSession {
    return new OrchestrationSession(
      structuredClone(manifest),
      new TaskGraph(graph.nodes, graph.id),
    );
  }

  public id(): string {
    return this.data.id;
  }
  public state(): OrchestrationState {
    return this.data.state;
  }
  public taskGraph(): TaskGraph {
    return this.graph;
  }
  public manifest(): OrchestrationSessionManifest {
    return structuredClone(this.data);
  }

  public transition(next: OrchestrationState): void {
    this.data.state = this.stateMachine.transition(this.data.state, next);
    this.touch();
  }

  public enterApprovalGate(requireApproval: boolean): void {
    if (this.data.state === "created") this.transition("planning");
    this.transition(requireApproval ? "awaiting_plan_approval" : "scheduled");
  }

  public approvePlan(actor: ApprovalActor): void {
    if (actor !== "user_cli" && actor !== "user_ui")
      throw new OrchestrationPlanApprovalRequiredError();
    this.transition("scheduled");
    const version = this.data.planVersions.at(-1);
    if (version !== undefined) version.approvedAt = new Date().toISOString();
    if (version !== undefined) this.data.approvedPlanVersion = version.version;
    this.touch();
  }

  public replacePlan(graph: TaskGraph, reason: string, requireApproval: boolean): void {
    if (this.data.state !== "replanning") this.transition("replanning");
    this.graph = graph;
    const version = (this.data.planVersions.at(-1)?.version ?? 0) + 1;
    this.data.planVersions.push({
      version,
      createdAt: new Date().toISOString(),
      reason,
      graph: graph.snapshot(),
    });
    this.data.usage.replans += 1;
    this.transition(requireApproval ? "awaiting_plan_approval" : "scheduled");
  }

  public syncLatestPlanGraph(): void {
    const version = this.data.planVersions.at(-1);
    if (version !== undefined) version.graph = this.graph.snapshot();
    this.touch();
  }

  public recordAgent(input: OrchestrationSessionManifest["agents"][number]): void {
    const existing = this.data.agents.findIndex((agent) => agent.id === input.id);
    if (existing === -1) this.data.agents.push(structuredClone(input));
    else this.data.agents[existing] = structuredClone(input);
    this.touch();
  }

  public recordResult(result: SpecialistResult): void {
    this.data.results[result.taskId] = structuredClone(result);
    this.touch();
  }

  public recordArtifact(artifact: SharedArtifact): void {
    if (!this.data.artifactIds.includes(artifact.id)) this.data.artifactIds.push(artifact.id);
    this.touch();
  }

  public setConflicts(conflicts: AgentConflict[]): void {
    this.data.conflicts = structuredClone(conflicts);
    this.touch();
  }

  public updateUsage(usage: OrchestrationUsage): void {
    this.data.usage = structuredClone(usage);
    this.touch();
  }

  public addWarning(warning: string): void {
    this.data.warnings.push(warning);
    this.touch();
  }

  public requireManualResume(): void {
    this.data.requiresManualResume = true;
    if (this.data.state !== "recovery_required") this.transition("recovery_required");
  }

  public resume(): void {
    this.transition("scheduled");
    this.data.requiresManualResume = false;
    this.touch();
  }

  public approveFinal(actor: ApprovalActor): void {
    if (actor !== "user_cli" && actor !== "user_ui")
      throw new OrchestrationFinalApprovalRequiredError();
    this.transition("completed");
    this.data.finalApprovedAt = new Date().toISOString();
    this.touch();
  }

  public rejectResult(): void {
    this.transition("replanning");
  }

  private touch(): void {
    this.data.updatedAt = new Date().toISOString();
  }
}

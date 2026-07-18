import type {
  SpecialistAccessPolicy,
  SpecialistExecutionContext,
  SpecialistInputArtifact,
  SpecialistResult,
  SpecialistRole,
  SpecialistTask,
} from "@local-code-agent/agent-specialists";
import {
  GraphScheduler,
  type OrchestrationTaskNode,
  type TaskGraph,
} from "@local-code-agent/task-graph";

import type {
  AgentExecutionContextFactory,
  CentralToolDispatcher,
} from "./agentExecutionContext.js";
import type { AgentFactory } from "./agentFactory.js";
import type { AgentResultValidator } from "./agentResultValidator.js";
import {
  SpecialistRetryLimitError,
  SpecialistTaskFailedError,
  SpecialistTaskTimeoutError,
  SecurityReviewBlockedError,
} from "./errors.js";
import type { FileLeaseService } from "./fileLeaseService.js";
import type { OrchestrationBudgetTracker } from "./orchestrationBudget.js";
import type { OrchestrationConfig } from "./orchestrationConfig.js";
import type { SharedArtifactStore } from "./sharedArtifactStore.js";
import type { OrchestrationArtifactType, SharedArtifact } from "./orchestrationTypes.js";

const TRANSIENT_CODES = new Set([
  "SPECIALIST_TASK_TIMEOUT",
  "MODEL_UNAVAILABLE",
  "OLLAMA_UNAVAILABLE",
  "TOOL_TIMEOUT",
]);

function allowedTools(access: SpecialistAccessPolicy): string[] {
  const tools: string[] = [];
  if (access.repositoryRead) tools.push("read_file", "search_repository", "get_change_preview");
  if (access.semanticSearch) tools.push("semantic_search");
  if (access.lspRead) tools.push("lsp_symbols");
  if (access.prepareChanges)
    tools.push("prepare_patch", "prepare_create_file", "prepare_delete_file", "prepare_move_file");
  if (access.runVerification) tools.push("run_verification");
  if (access.executeCommands) tools.push("run_project_command");
  if (access.useMcp) tools.push("mcp_read");
  if (access.remoteRead) tools.push("remote_read");
  return tools;
}

function toTask(sessionId: string, node: OrchestrationTaskNode): SpecialistTask {
  return {
    id: node.id,
    sessionId,
    title: node.title,
    description: node.description,
    role: node.assignedRole,
    accessMode: node.accessMode,
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
}

function asInput(artifact: SharedArtifact): SpecialistInputArtifact {
  return {
    id: artifact.id,
    type: artifact.type,
    producerTaskId: artifact.producerTaskId,
    version: artifact.version,
    payload: structuredClone(artifact.payload),
    warnings: [...artifact.warnings],
  };
}

export interface SchedulerEvent {
  type: "agent_started" | "agent_completed" | "node_failed" | "artifact_created";
  taskId: string;
  role: SpecialistRole;
  result?: SpecialistResult;
  artifact?: SharedArtifact;
  warning?: string;
  error?: unknown;
}

export class OrchestrationScheduler {
  private readonly graphScheduler = new GraphScheduler();

  public constructor(
    private readonly services: {
      agentFactory: AgentFactory;
      contextFactory: AgentExecutionContextFactory;
      resultValidator: AgentResultValidator;
      artifacts: SharedArtifactStore;
      leases: FileLeaseService;
      budget: OrchestrationBudgetTracker;
      config: OrchestrationConfig;
      dispatcher: CentralToolDispatcher;
      repositoryContext: SpecialistExecutionContext["repositoryContext"];
      signal?: AbortSignal;
      onEvent?: (event: SchedulerEvent) => Promise<void> | void;
    },
  ) {}

  public async execute(
    sessionId: string,
    graph: TaskGraph,
  ): Promise<Record<string, SpecialistResult>> {
    const results: Record<string, SpecialistResult> = {};
    while (true) {
      if (this.services.signal?.aborted === true)
        throw new SpecialistTaskFailedError("Sesja orkiestracji została anulowana.");
      this.services.budget.assertTime();
      graph.refreshReadiness();
      const unfinished = graph
        .list()
        .filter((node) => !["completed", "skipped", "cancelled"].includes(node.status));
      if (unfinished.length === 0) return results;
      const ready = graph.ready();
      if (ready.length === 0) {
        throw new SpecialistTaskFailedError(
          "Graf zawiera zablokowane lub zakończone błędem zadania.",
        );
      }
      const batch = this.graphScheduler.selectBatch(ready, {
        maxParallel: this.services.config.maxParallelAgents,
        allowParallelWrites: this.services.config.allowParallelWrites,
      });
      this.services.budget.observeParallel(batch.length);
      await Promise.all(
        batch.map(async (node) => {
          const result = await this.executeNode(sessionId, graph, node);
          results[node.id] = result;
        }),
      );
    }
  }

  private async executeNode(
    sessionId: string,
    graph: TaskGraph,
    node: OrchestrationTaskNode,
  ): Promise<SpecialistResult> {
    graph.setStatus(node.id, "running");
    const lease =
      (node.files?.length ?? 0) > 0
        ? this.services.leases.acquire({
            taskNodeId: node.id,
            paths: node.files ?? [],
            mode: node.accessMode === "prepare_changes" ? "write" : "read",
            timeoutMs: this.services.config.fileLeaseTimeoutMs,
          })
        : undefined;
    try {
      const created = await this.services.agentFactory.create(
        node.assignedRole,
        node.id,
        node.depth ?? 1,
      );
      await this.services.onEvent?.({
        type: "agent_started",
        taskId: node.id,
        role: node.assignedRole,
        ...(created.warning === undefined ? {} : { warning: created.warning }),
      });
      const dependencyIds = new Set<string>();
      const pendingDependencies = [...node.dependencies];
      while (pendingDependencies.length > 0) {
        const dependencyId = pendingDependencies.pop();
        if (dependencyId === undefined || dependencyIds.has(dependencyId)) continue;
        dependencyIds.add(dependencyId);
        pendingDependencies.push(...graph.get(dependencyId).dependencies);
      }
      const artifacts = this.services.artifacts
        .list(sessionId)
        .filter((artifact) => dependencyIds.has(artifact.producerTaskId))
        .map(asInput);
      const task = toTask(sessionId, node);
      let attempt = 0;
      while (true) {
        try {
          const controller = new AbortController();
          const signal =
            this.services.signal === undefined
              ? controller.signal
              : AbortSignal.any([controller.signal, this.services.signal]);
          const context = this.services.contextFactory.create({
            sessionId,
            taskId: node.id,
            role: node.assignedRole,
            access: created.agent.access,
            model: created.model,
            artifacts,
            repositoryContext: this.services.repositoryContext,
            allowedTools: allowedTools(created.agent.access),
            dispatcher: this.services.dispatcher,
            signal,
          });
          const raw = await this.withTimeout(
            created.agent.execute(task, context),
            node.budget.maxDurationMs,
            controller,
          );
          const result = this.services.resultValidator.validate(raw, node.id, node.assignedRole);
          if (result.status !== "completed" && result.status !== "security_stop") {
            throw new SpecialistTaskFailedError(`${node.id}: ${result.status}: ${result.summary}`);
          }
          const returnedTypes = new Set(result.artifacts.map((artifact) => artifact.type));
          const missingOutputs = node.expectedOutputs.filter((type) => !returnedTypes.has(type));
          if (missingOutputs.length > 0) {
            throw new SpecialistTaskFailedError(
              `Zadanie ${node.id} nie zwróciło wymaganych artefaktów: ${missingOutputs.join(", ")}.`,
            );
          }
          for (const draft of result.artifacts) {
            if (!node.expectedOutputs.includes(draft.type as OrchestrationArtifactType)) {
              throw new SpecialistTaskFailedError(
                `Zadanie ${node.id} zwróciło nieoczekiwany artefakt ${draft.type}.`,
              );
            }
            const artifact = await this.services.artifacts.create({
              sessionId,
              producerTaskId: node.id,
              producerRole: node.assignedRole,
              type: draft.type as OrchestrationArtifactType,
              payload: draft.payload,
              ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }),
              warnings: draft.warnings,
            });
            await this.services.onEvent?.({
              type: "artifact_created",
              taskId: node.id,
              role: node.assignedRole,
              artifact,
            });
          }
          this.services.budget.consume(result.usage ?? {});
          this.services.budget.markCompleted();
          graph.setStatus(node.id, result.status === "security_stop" ? "failed" : "completed");
          await this.services.onEvent?.({
            type: "agent_completed",
            taskId: node.id,
            role: node.assignedRole,
            result,
          });
          if (result.status === "security_stop")
            throw new SecurityReviewBlockedError(result.summary);
          return result;
        } catch (error) {
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? String(error.code)
              : "";
          if (
            !TRANSIENT_CODES.has(code) ||
            attempt >= Math.min(node.budget.maxRetries, this.services.config.maxTaskRetries)
          ) {
            throw error;
          }
          attempt += 1;
          this.services.budget.markRetry();
        }
      }
    } catch (error) {
      this.services.budget.markFailed();
      if (graph.get(node.id).status === "running") graph.setStatus(node.id, "failed");
      await this.services.onEvent?.({
        type: "node_failed",
        taskId: node.id,
        role: node.assignedRole,
        error,
      });
      throw error instanceof Error
        ? error
        : new SpecialistRetryLimitError("Specjalista zakończył się nieznanym błędem.");
    } finally {
      if (lease !== undefined) this.services.leases.release(lease.id);
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    controller: AbortController,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new SpecialistTaskTimeoutError());
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timed]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

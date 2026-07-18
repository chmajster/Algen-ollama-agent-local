import {
  AgentCreationLimitError,
  AgentDepthLimitError,
  AgentParallelLimitError,
  OrchestrationBudgetExceededError,
} from "./errors.js";
import type { OrchestrationBudget, OrchestrationUsage } from "./orchestrationTypes.js";

export class OrchestrationBudgetTracker {
  readonly #budget: Readonly<OrchestrationBudget>;
  readonly #usage: OrchestrationUsage;
  readonly #startedAt: number;

  public constructor(budget: OrchestrationBudget, usage?: OrchestrationUsage, now = Date.now()) {
    this.#budget = Object.freeze({ ...budget });
    this.#usage =
      usage === undefined
        ? {
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
          }
        : structuredClone(usage);
    this.#startedAt = now;
  }

  public createAgent(depth: number): void {
    if (depth > this.#budget.maxDepth) throw new AgentDepthLimitError();
    if (this.#usage.agentsCreated >= this.#budget.maxAgents) throw new AgentCreationLimitError();
    this.#usage.agentsCreated += 1;
  }

  public createSubtask(count = 1): void {
    this.#usage.subtasksCreated += count;
    if (this.#usage.subtasksCreated > this.#budget.maxSubtasks)
      throw new OrchestrationBudgetExceededError("Przekroczono limit podzadań.");
  }

  public observeParallel(active: number): void {
    if (active > this.#budget.maxParallelAgents) throw new AgentParallelLimitError();
    this.#usage.maxParallelObserved = Math.max(this.#usage.maxParallelObserved, active);
  }

  public consume(input: {
    steps?: number;
    toolCalls?: number;
    commands?: number;
    contextTokens?: number;
    durationMs?: number;
  }): void {
    this.#usage.totalSteps += input.steps ?? 0;
    this.#usage.totalToolCalls += input.toolCalls ?? 0;
    this.#usage.totalCommands += input.commands ?? 0;
    this.#usage.estimatedContextTokens += input.contextTokens ?? 0;
    this.#usage.totalDurationMs += input.durationMs ?? 0;
    if (
      this.#usage.totalSteps > this.#budget.maxTotalSteps ||
      this.#usage.totalToolCalls > this.#budget.maxTotalToolCalls ||
      this.#usage.totalCommands > this.#budget.maxTotalCommands ||
      this.#usage.estimatedContextTokens > this.#budget.maxTotalContextTokens ||
      this.#usage.totalDurationMs > this.#budget.maxTotalDurationMs
    ) {
      throw new OrchestrationBudgetExceededError();
    }
  }

  public assertTime(now = Date.now()): void {
    if (now - this.#startedAt > this.#budget.maxTotalDurationMs) {
      throw new OrchestrationBudgetExceededError("Przekroczono całkowity czas orkiestracji.");
    }
  }

  public markCompleted(): void {
    this.#usage.agentsCompleted += 1;
  }
  public markFailed(): void {
    this.#usage.agentsFailed += 1;
  }
  public markReplan(): void {
    this.#usage.replans += 1;
  }
  public markRetry(): void {
    this.#usage.retries += 1;
  }
  public budget(): OrchestrationBudget {
    return { ...this.#budget };
  }
  public usage(): OrchestrationUsage {
    return structuredClone(this.#usage);
  }
}

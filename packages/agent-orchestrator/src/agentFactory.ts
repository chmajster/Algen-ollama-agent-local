import {
  ArchitectureAgent,
  DocumentationAgent,
  ImplementationAgent,
  PerformanceAgent,
  PlannerAgent,
  RepositoryExplorerAgent,
  ReviewAgent,
  SecurityAgent,
  TestAgent,
  type SpecialistAgent,
  type SpecialistModelRunner,
  type SpecialistRole,
} from "@local-code-agent/agent-specialists";

import { AgentRegistry } from "./agentRegistry.js";
import { SpecialistModelUnavailableError } from "./errors.js";
import type { OrchestrationBudgetTracker } from "./orchestrationBudget.js";
import type { OrchestrationConfig } from "./orchestrationConfig.js";

export interface CreatedSpecialist {
  agent: SpecialistAgent;
  model: string;
  warning?: string;
}

export function createDefaultAgentRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register("planner", (id, runner) => new PlannerAgent(id, runner));
  registry.register("repository_explorer", (id, runner) => new RepositoryExplorerAgent(id, runner));
  registry.register("architecture", (id, runner) => new ArchitectureAgent(id, runner));
  registry.register("implementation", (id, runner) => new ImplementationAgent(id, runner));
  registry.register("test", (id, runner) => new TestAgent(id, runner));
  registry.register("review", (id, runner) => new ReviewAgent(id, runner));
  registry.register("security", (id, runner) => new SecurityAgent(id, runner));
  registry.register("performance", (id, runner) => new PerformanceAgent(id, runner));
  registry.register("documentation", (id, runner) => new DocumentationAgent(id, runner));
  return registry;
}

export class AgentFactory {
  public constructor(
    private readonly registry: AgentRegistry,
    private readonly runner: SpecialistModelRunner,
    private readonly config: OrchestrationConfig,
    private readonly budget: OrchestrationBudgetTracker,
  ) {}

  public async create(
    role: SpecialistRole,
    taskId: string,
    depth: number,
  ): Promise<CreatedSpecialist> {
    this.budget.createAgent(depth);
    const requested = this.config.roleModels[role] || this.config.modelDefault;
    let model = requested;
    let warning: string | undefined;
    if (
      this.runner.isModelAvailable !== undefined &&
      !(await this.runner.isModelAvailable(requested))
    ) {
      model = this.config.modelDefault;
      warning = `Model ${requested} dla ${role} jest niedostępny; użyto ${model}.`;
      if (!(await this.runner.isModelAvailable(model))) {
        throw new SpecialistModelUnavailableError(`Model domyślny ${model} jest niedostępny.`);
      }
    }
    return {
      agent: this.registry.create(role, `${taskId}:${role}`, this.runner),
      model,
      ...(warning === undefined ? {} : { warning }),
    };
  }
}

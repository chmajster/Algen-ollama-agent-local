import type {
  AgentCapability,
  SpecialistAccessPolicy,
  SpecialistExecutionContext,
  SpecialistModelRunner,
  SpecialistResult,
  SpecialistRole,
  SpecialistTask,
} from "./specialistTypes.js";

export interface SpecialistAgent {
  readonly id: string;
  readonly role: SpecialistRole;
  readonly capabilities: AgentCapability[];
  readonly access: SpecialistAccessPolicy;
  execute(task: SpecialistTask, context: SpecialistExecutionContext): Promise<SpecialistResult>;
}

export abstract class BaseSpecialistAgent implements SpecialistAgent {
  public abstract readonly role: SpecialistRole;
  public abstract readonly capabilities: AgentCapability[];
  public abstract readonly access: SpecialistAccessPolicy;

  public constructor(
    public readonly id: string,
    protected readonly runner: SpecialistModelRunner,
    private readonly prompt: string,
  ) {}

  public async execute(
    task: SpecialistTask,
    context: SpecialistExecutionContext,
  ): Promise<SpecialistResult> {
    if (task.role !== this.role)
      throw new Error(`Task ${task.id} is assigned to ${task.role}, not ${this.role}.`);
    return this.runner.execute({
      role: this.role,
      model: context.model,
      systemPrompt: `${this.prompt}\n\nTask ID: ${task.id}\nBudget: ${JSON.stringify(task.budget)}`,
      task,
      artifacts: context.artifacts.map((artifact) => structuredClone(artifact)),
      repositoryContext: structuredClone(context.repositoryContext),
      toolGateway: context.toolGateway,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  }
}

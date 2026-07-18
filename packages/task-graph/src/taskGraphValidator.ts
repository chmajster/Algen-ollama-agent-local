import { DependencyResolver } from "./dependencyResolver.js";
import { TaskGraphInvalidError, TaskGraphLimitError } from "./errors.js";
import type {
  GraphSpecialistRole,
  OrchestrationTaskNode,
  TaskGraphValidationOptions,
} from "./graphTypes.js";

const ROLES = new Set<GraphSpecialistRole>([
  "planner",
  "repository_explorer",
  "architecture",
  "implementation",
  "test",
  "review",
  "security",
  "performance",
  "documentation",
]);

export class TaskGraphValidator {
  private readonly resolver = new DependencyResolver();

  public validate(
    nodes: readonly OrchestrationTaskNode[],
    options: TaskGraphValidationOptions,
  ): void {
    if (nodes.length === 0)
      throw new TaskGraphInvalidError("Graf musi zawierać co najmniej jeden węzeł.");
    if (nodes.length > options.maxNodes) {
      throw new TaskGraphLimitError(
        `Graf ma ${nodes.length} węzłów; limit wynosi ${options.maxNodes}.`,
      );
    }
    const ids = new Set<string>();
    for (const node of nodes) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(node.id)) {
        throw new TaskGraphInvalidError(`Niepoprawny identyfikator węzła: ${node.id}.`);
      }
      if (ids.has(node.id)) throw new TaskGraphInvalidError(`Duplikat identyfikatora ${node.id}.`);
      ids.add(node.id);
      if (!ROLES.has(node.assignedRole)) {
        throw new TaskGraphInvalidError(`Nieznana rola w węźle ${node.id}.`);
      }
      if ((node.depth ?? 1) > options.maxDepth) {
        throw new TaskGraphLimitError(`Węzeł ${node.id} przekracza maksymalną głębokość.`);
      }
      if (
        new Set(node.dependencies).size !== node.dependencies.length ||
        node.dependencies.includes(node.id)
      ) {
        throw new TaskGraphInvalidError(`Węzeł ${node.id} ma niepoprawne zależności.`);
      }
      if (
        node.accessMode === "prepare_changes" &&
        node.assignedRole !== "implementation" &&
        node.assignedRole !== "documentation" &&
        node.assignedRole !== "test"
      ) {
        throw new TaskGraphInvalidError(`Rola ${node.assignedRole} nie może przygotowywać zmian.`);
      }
      if (
        node.budget.maxSteps <= 0 ||
        node.budget.maxToolCalls <= 0 ||
        node.budget.maxDurationMs <= 0
      ) {
        throw new TaskGraphInvalidError(`Węzeł ${node.id} ma niepoprawny budżet.`);
      }
    }
    this.resolver.topologicalOrder(nodes);
  }
}

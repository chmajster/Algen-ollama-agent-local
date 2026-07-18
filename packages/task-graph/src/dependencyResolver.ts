import { TaskGraphCycleError, TaskGraphDependencyError } from "./errors.js";
import type { OrchestrationTaskNode } from "./graphTypes.js";

export class DependencyResolver {
  public topologicalOrder(nodes: readonly OrchestrationTaskNode[]): string[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    const dependents = new Map<string, string[]>();
    for (const node of nodes) {
      for (const dependency of node.dependencies) {
        if (!byId.has(dependency)) {
          throw new TaskGraphDependencyError(
            `Węzeł ${node.id} zależy od brakującego ${dependency}.`,
          );
        }
        indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
        const list = dependents.get(dependency) ?? [];
        list.push(node.id);
        dependents.set(dependency, list);
      }
    }
    const ready = [...nodes]
      .filter((node) => indegree.get(node.id) === 0)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => node.id);
    const result: string[] = [];
    while (ready.length > 0) {
      const id = ready.shift();
      if (id === undefined) break;
      result.push(id);
      for (const dependent of (dependents.get(id) ?? []).sort()) {
        const next = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, next);
        if (next === 0) ready.push(dependent);
      }
      ready.sort();
    }
    if (result.length !== nodes.length) throw new TaskGraphCycleError();
    return result;
  }

  public transitiveDependencies(
    nodeId: string,
    nodes: readonly OrchestrationTaskNode[],
  ): Set<string> {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const result = new Set<string>();
    const visit = (id: string): void => {
      const node = byId.get(id);
      if (node === undefined) throw new TaskGraphDependencyError(`Nie znaleziono węzła ${id}.`);
      for (const dependency of node.dependencies) {
        if (!result.has(dependency)) {
          result.add(dependency);
          visit(dependency);
        }
      }
    };
    visit(nodeId);
    return result;
  }
}

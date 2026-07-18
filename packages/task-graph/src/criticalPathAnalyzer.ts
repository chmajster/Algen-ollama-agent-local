import { DependencyResolver } from "./dependencyResolver.js";
import type { OrchestrationTaskNode } from "./graphTypes.js";

export interface CriticalPathResult {
  nodeIds: string[];
  estimatedDurationMs: number;
}

export class CriticalPathAnalyzer {
  public analyze(nodes: readonly OrchestrationTaskNode[]): CriticalPathResult {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const order = new DependencyResolver().topologicalOrder(nodes);
    const longest = new Map<string, { duration: number; path: string[] }>();
    for (const id of order) {
      const node = byId.get(id);
      if (node === undefined) continue;
      let best = { duration: 0, path: [] as string[] };
      for (const dependency of node.dependencies) {
        const candidate = longest.get(dependency);
        if (candidate !== undefined && candidate.duration > best.duration) best = candidate;
      }
      longest.set(id, {
        duration: best.duration + node.budget.maxDurationMs,
        path: [...best.path, id],
      });
    }
    return [...longest.values()].reduce<CriticalPathResult>(
      (best, current) =>
        current.duration > best.estimatedDurationMs
          ? { nodeIds: current.path, estimatedDurationMs: current.duration }
          : best,
      { nodeIds: [], estimatedDurationMs: 0 },
    );
  }
}

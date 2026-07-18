import { describe, expect, it } from "vitest";

import {
  DEFAULT_SPECIALIST_TASK_BUDGET,
  EMPTY_SPECIALIST_TASK_USAGE,
  TaskGraph,
  type OrchestrationTaskNode,
} from "../src/index.js";

describe("task graph performance", () => {
  it("validates and schedules a 500-node DAG within a bounded time", () => {
    const nodes: OrchestrationTaskNode[] = Array.from({ length: 500 }, (_, index) => ({
      id: `node_${String(index).padStart(3, "0")}`,
      title: `Node ${index}`,
      description: "Performance fixture",
      assignedRole: "repository_explorer",
      dependencies: index === 0 ? [] : [`node_${String(index - 1).padStart(3, "0")}`],
      status: "pending",
      accessMode: "read_only",
      expectedInputs: [],
      expectedOutputs: [],
      risk: "low",
      depth: 1,
      budget: { ...DEFAULT_SPECIALIST_TASK_BUDGET },
      usage: { ...EMPTY_SPECIALIST_TASK_USAGE },
    }));
    const startedAt = performance.now();
    const graph = new TaskGraph(nodes);
    graph.validate(500, 2);
    expect(graph.topologicalOrder()).toHaveLength(500);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });
});

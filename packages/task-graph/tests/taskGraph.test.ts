import { describe, expect, it } from "vitest";

import {
  CriticalPathAnalyzer,
  DEFAULT_SPECIALIST_TASK_BUDGET,
  EMPTY_SPECIALIST_TASK_USAGE,
  GraphScheduler,
  TaskGraph,
  TaskGraphBuilder,
  TaskGraphCycleError,
  TaskGraphDependencyError,
  TaskGraphInvalidError,
  TaskGraphLimitError,
  type GraphSpecialistRole,
  type OrchestrationTaskNode,
} from "../src/index.js";

const roles: GraphSpecialistRole[] = [
  "planner",
  "repository_explorer",
  "architecture",
  "implementation",
  "test",
  "review",
  "security",
  "performance",
  "documentation",
];

function node(
  id: string,
  dependencies: string[] = [],
  accessMode: OrchestrationTaskNode["accessMode"] = "read_only",
): OrchestrationTaskNode {
  return {
    id,
    title: id,
    description: id,
    assignedRole: "planner",
    dependencies,
    status: "pending",
    accessMode,
    expectedInputs: [],
    expectedOutputs: [],
    risk: "low",
    depth: 1,
    budget: { ...DEFAULT_SPECIALIST_TASK_BUDGET },
    usage: { ...EMPTY_SPECIALIST_TASK_USAGE },
  };
}

describe("task graph", () => {
  it.each(roles)("accepts specialist role %s", (role) => {
    const graph = new TaskGraph([{ ...node(role), assignedRole: role }]);
    expect(() => graph.validate()).not.toThrow();
  });

  it.each([
    ["pending", "ready"],
    ["pending", "blocked"],
    ["pending", "cancelled"],
    ["ready", "running"],
    ["running", "completed"],
    ["running", "failed"],
    ["failed", "ready"],
    ["blocked", "ready"],
  ] as const)("allows transition %s -> %s", (from, to) => {
    const graph = new TaskGraph([{ ...node("n"), status: from }]);
    expect(graph.setStatus("n", to).status).toBe(to);
  });

  it("throws on a missing dependency during validation", () => {
    const graph = new TaskGraph([node("node_a", ["missing"])]);
    expect(() => graph.validate()).toThrow(TaskGraphDependencyError);
  });

  it("rejects a cycle", () => {
    expect(() =>
      new TaskGraph([node("node_a", ["node_b"]), node("node_b", ["node_a"])]).validate(),
    ).toThrow(TaskGraphCycleError);
  });

  it("rejects duplicate ids", () => {
    expect(() => new TaskGraph([node("a"), node("a")]).validate()).toThrow(TaskGraphInvalidError);
  });

  it("enforces node limit", () => {
    expect(() => new TaskGraph([node("a"), node("b")]).validate(1)).toThrow(TaskGraphLimitError);
  });

  it("enforces depth limit", () => {
    expect(() => new TaskGraph([{ ...node("node_a"), depth: 3 }]).validate(30, 2)).toThrow(
      TaskGraphLimitError,
    );
  });

  it("makes roots ready", () => {
    const graph = new TaskGraph([node("a"), node("b", ["a"])]);
    graph.refreshReadiness();
    expect(graph.ready().map((item) => item.id)).toEqual(["a"]);
  });

  it("unblocks dependants after completion", () => {
    const graph = new TaskGraph([node("a"), node("b", ["a"])]);
    graph.refreshReadiness();
    graph.setStatus("a", "running");
    graph.setStatus("a", "completed");
    graph.refreshReadiness();
    expect(graph.get("b").status).toBe("ready");
  });

  it.each([
    [1, false, 1],
    [2, false, 2],
    [3, false, 2],
    [3, true, 3],
    [4, false, 2],
    [2, true, 2],
  ] as const)(
    "schedules max=%i parallelWrites=%s",
    (maxParallel, allowParallelWrites, expected) => {
      const ready = [
        { ...node("r"), status: "ready" as const },
        { ...node("w1", [], "prepare_changes"), status: "ready" as const, files: ["a.ts"] },
        { ...node("w2", [], "prepare_changes"), status: "ready" as const, files: ["b.ts"] },
      ];
      expect(
        new GraphScheduler().selectBatch(ready, { maxParallel, allowParallelWrites }),
      ).toHaveLength(expected);
    },
  );

  it("does not schedule conflicting file access", () => {
    const ready = [
      { ...node("w", [], "prepare_changes"), status: "ready" as const, files: ["a.ts"] },
      { ...node("r"), status: "ready" as const, files: ["a.ts"] },
    ];
    expect(
      new GraphScheduler().selectBatch(ready, { maxParallel: 2, allowParallelWrites: false }),
    ).toHaveLength(1);
  });

  it.each([1, 10, 100, 1_000])("calculates critical path with duration %i", (duration) => {
    const nodes = [node("a"), node("b", ["a"]), node("c", ["b"])].map((item) => ({
      ...item,
      budget: { ...item.budget, maxDurationMs: duration },
    }));
    expect(new CriticalPathAnalyzer().analyze(nodes)).toEqual({
      nodeIds: ["a", "b", "c"],
      estimatedDurationMs: duration * 3,
    });
  });

  it("adds mandatory review nodes after the terminal task", () => {
    const graph = new TaskGraphBuilder().build(
      [
        {
          id: "analysis",
          title: "Analysis",
          description: "Analysis",
          assignedRole: "architecture",
          accessMode: "read_only",
        },
      ],
      { requireReview: true, requireSecurityReview: true, maxNodes: 10, maxDepth: 2 },
    );
    expect(graph.get("security_review").dependencies).toEqual(["analysis"]);
    expect(graph.get("independent_review").dependencies).toContain("security_review");
  });
});

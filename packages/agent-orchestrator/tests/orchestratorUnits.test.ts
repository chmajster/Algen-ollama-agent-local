import { describe, expect, it } from "vitest";

import {
  accessPolicyForRole,
  type SpecialistResult,
  type SpecialistRole,
} from "@local-code-agent/agent-specialists";

import {
  AgentMessageBus,
  ConsensusService,
  FileLeaseConflictError,
  FileLeaseService,
  OrchestrationBudgetTracker,
  OrchestrationPolicy,
  OrchestrationStateMachine,
  SharedArtifactStore,
  SpecialistAccessDeniedError,
  artifactContentHash,
  type OrchestrationBudget,
  type OrchestrationState,
} from "../src/index.js";

const transitions: Array<[OrchestrationState, OrchestrationState]> = [
  ["created", "planning"],
  ["created", "cancelled"],
  ["planning", "awaiting_plan_approval"],
  ["planning", "scheduled"],
  ["awaiting_plan_approval", "scheduled"],
  ["scheduled", "running"],
  ["running", "replanning"],
  ["running", "merging_changes"],
  ["running", "verifying"],
  ["running", "reviewing"],
  ["running", "security_review"],
  ["running", "awaiting_final_approval"],
  ["running", "failed"],
  ["running", "security_stopped"],
  ["replanning", "awaiting_plan_approval"],
  ["merging_changes", "verifying"],
  ["verifying", "reviewing"],
  ["reviewing", "security_review"],
  ["security_review", "awaiting_final_approval"],
  ["awaiting_final_approval", "completed"],
  ["failed", "recovery_required"],
  ["recovery_required", "scheduled"],
];

const budget: OrchestrationBudget = {
  maxAgents: 1,
  maxParallelAgents: 1,
  maxSubtasks: 1,
  maxDepth: 1,
  maxTotalSteps: 1,
  maxTotalToolCalls: 1,
  maxTotalCommands: 1,
  maxTotalDurationMs: 10,
  maxTotalContextTokens: 1,
};

function result(
  role: SpecialistRole,
  status: SpecialistResult["status"] = "completed",
): SpecialistResult {
  const artifacts =
    role === "review"
      ? [
          {
            type: "review_report",
            payload: { verdict: "approve", findings: [], planCoverage: [], limitations: [] },
            warnings: [],
          },
        ]
      : role === "security"
        ? [
            {
              type: "security_report",
              payload: { verdict: "pass", findings: [], reviewedAreas: ["code"], limitations: [] },
              warnings: [],
            },
          ]
        : [];
  return {
    taskId: role,
    role,
    status,
    summary: role,
    artifacts,
    evidence: [{ type: "file", reference: "README.md" }],
    proposedActions: [],
    confidence: "high",
    limitations: [],
    warnings: [],
  };
}

describe("orchestrator units", () => {
  it.each(transitions)("allows state transition %s -> %s", (from, to) => {
    expect(new OrchestrationStateMachine().transition(from, to)).toBe(to);
  });

  it.each([
    [
      "agents",
      (tracker: OrchestrationBudgetTracker) => {
        tracker.createAgent(1);
        tracker.createAgent(1);
      },
    ],
    ["depth", (tracker: OrchestrationBudgetTracker) => tracker.createAgent(2)],
    ["parallel", (tracker: OrchestrationBudgetTracker) => tracker.observeParallel(2)],
    ["subtasks", (tracker: OrchestrationBudgetTracker) => tracker.createSubtask(2)],
    ["steps", (tracker: OrchestrationBudgetTracker) => tracker.consume({ steps: 2 })],
    ["tools", (tracker: OrchestrationBudgetTracker) => tracker.consume({ toolCalls: 2 })],
    ["commands", (tracker: OrchestrationBudgetTracker) => tracker.consume({ commands: 2 })],
    ["tokens", (tracker: OrchestrationBudgetTracker) => tracker.consume({ contextTokens: 2 })],
    ["duration", (tracker: OrchestrationBudgetTracker) => tracker.consume({ durationMs: 11 })],
  ] as const)("enforces %s budget", (_name, operation) => {
    expect(() => operation(new OrchestrationBudgetTracker(budget))).toThrow();
  });

  it.each([
    ["planner", "read_file"],
    ["planner", "search_repository"],
    ["planner", "semantic_search"],
    ["planner", "lsp_symbols"],
    ["implementation", "prepare_patch"],
    ["implementation", "prepare_create_file"],
    ["implementation", "prepare_delete_file"],
    ["implementation", "prepare_move_file"],
    ["test", "run_verification"],
    ["test", "run_project_command"],
    ["repository_explorer", "mcp_read"],
  ] as const)("allows %s to use %s", (role, tool) => {
    expect(() =>
      new OrchestrationPolicy().assertToolAllowed(role, accessPolicyForRole(role), tool),
    ).not.toThrow();
  });

  it.each([
    "apply_changes",
    "restore_checkpoint",
    "remote_write",
    "publish_branch",
    "create_pull_request",
    "create_agent",
    "create_orchestration_session",
    "unknown_tool",
  ])("always denies specialist tool %s", (tool) => {
    expect(() =>
      new OrchestrationPolicy().assertToolAllowed(
        "implementation",
        accessPolicyForRole("implementation"),
        tool,
      ),
    ).toThrow(SpecialistAccessDeniedError);
  });

  it("allows concurrent read leases", () => {
    const leases = new FileLeaseService();
    leases.acquire({ taskNodeId: "a", paths: ["src/a.ts"], mode: "read", timeoutMs: 1_000 });
    expect(() =>
      leases.acquire({ taskNodeId: "b", paths: ["src/a.ts"], mode: "read", timeoutMs: 1_000 }),
    ).not.toThrow();
  });

  it.each(["src/a.ts", "SRC\\A.TS", "src", "src/a.ts/child"])(
    "blocks a write conflict for %s",
    (path) => {
      const leases = new FileLeaseService();
      leases.acquire({ taskNodeId: "a", paths: ["src/a.ts"], mode: "write", timeoutMs: 1_000 });
      expect(() =>
        leases.acquire({ taskNodeId: "b", paths: [path], mode: "read", timeoutMs: 1_000 }),
      ).toThrow(FileLeaseConflictError);
    },
  );

  it("releases expired leases", () => {
    const leases = new FileLeaseService();
    leases.acquire({
      taskNodeId: "a",
      paths: ["a"],
      mode: "write",
      timeoutMs: 1,
      now: new Date(0),
    });
    expect(leases.releaseExpired(new Date(2))).toBe(1);
  });

  it("calculates weighted consensus", () => {
    const decision = new ConsensusService().evaluate(
      [
        result("architecture"),
        result("implementation"),
        result("test"),
        result("review"),
        result("security"),
      ],
      { threshold: 0.67, requireReview: true, requireSecurityReview: true },
    );
    expect(decision).toMatchObject({ outcome: "approved", score: 1 });
  });

  it("requires independent review", () => {
    expect(() =>
      new ConsensusService().evaluate([result("security")], {
        threshold: 0.67,
        requireReview: true,
        requireSecurityReview: true,
      }),
    ).toThrow();
  });

  it("requires security review", () => {
    expect(() =>
      new ConsensusService().evaluate([result("review")], {
        threshold: 0.67,
        requireReview: true,
        requireSecurityReview: true,
      }),
    ).toThrow();
  });

  it("blocks security veto", () => {
    const security = result("security", "security_stop");
    expect(() =>
      new ConsensusService().evaluate([result("review"), security], {
        threshold: 0.67,
        requireReview: true,
        requireSecurityReview: true,
      }),
    ).toThrow();
  });

  it.each([
    "repository_map",
    "implementation_plan",
    "verification_report",
    "final_summary",
  ] as const)("hashes %s deterministically", (type) => {
    expect(artifactContentHash({ type, a: 1, b: 2 })).toBe(
      artifactContentHash({ b: 2, a: 1, type }),
    );
  });

  it("stores and versions structured artifacts", async () => {
    const store = new SharedArtifactStore(10_000);
    const input = {
      sessionId: "s",
      producerTaskId: "p",
      producerRole: "repository_explorer" as const,
      type: "repository_map" as const,
      payload: { files: ["a"], summary: "map" },
    };
    expect((await store.create(input)).version).toBe(1);
    expect((await store.create(input)).version).toBe(2);
  });

  it("rejects private reasoning in artifacts", async () => {
    const store = new SharedArtifactStore(10_000);
    await expect(
      store.create({
        sessionId: "s",
        producerTaskId: "p",
        producerRole: "planner",
        type: "final_summary",
        payload: { status: "ok", summary: "ok", reasoning: "private" },
      }),
    ).rejects.toThrow();
  });

  it("routes structured messages", () => {
    const bus = new AgentMessageBus("s", new Set(["a", "b"]), 1_000);
    bus.publish({
      fromTaskId: "a",
      toTaskId: "b",
      type: "artifact_available",
      payload: { artifactId: "x" },
    });
    expect(bus.forTask("b")).toHaveLength(1);
  });

  it("rejects chat history in messages", () => {
    const bus = new AgentMessageBus("s", new Set(["a", "b"]), 1_000);
    expect(() =>
      bus.publish({
        fromTaskId: "a",
        toTaskId: "b",
        type: "clarification_request",
        payload: { history: [] },
      }),
    ).toThrow();
  });
});

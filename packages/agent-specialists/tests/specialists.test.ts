import { describe, expect, it, vi } from "vitest";

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
  accessPolicyForRole,
  capabilitiesForRole,
  type SpecialistAgent,
  type SpecialistModelRunner,
  type SpecialistRole,
  type SpecialistTask,
} from "../src/index.js";

const roles: SpecialistRole[] = [
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

function agent(role: SpecialistRole, runner: SpecialistModelRunner): SpecialistAgent {
  const classes = {
    planner: PlannerAgent,
    repository_explorer: RepositoryExplorerAgent,
    architecture: ArchitectureAgent,
    implementation: ImplementationAgent,
    test: TestAgent,
    review: ReviewAgent,
    security: SecurityAgent,
    performance: PerformanceAgent,
    documentation: DocumentationAgent,
  };
  return new classes[role](`agent-${role}`, runner);
}

function task(role: SpecialistRole): SpecialistTask {
  return {
    id: `task-${role}`,
    sessionId: "session",
    title: role,
    description: role,
    role,
    accessMode: "read_only",
    files: [],
    requirements: [],
    expectedArtifactTypes: [],
    depth: 1,
    budget: {
      maxSteps: 3,
      maxToolCalls: 4,
      maxCommands: 1,
      maxContextTokens: 1_000,
      maxDurationMs: 1_000,
    },
  };
}

function runner(): SpecialistModelRunner {
  return {
    execute: vi.fn(async (request) => ({
      taskId: request.task.id,
      role: request.role,
      status: "completed" as const,
      summary: "ok",
      artifacts: [],
      evidence: [{ type: "file" as const, reference: "README.md" }],
      proposedActions: [],
      confidence: "high" as const,
      limitations: [],
      warnings: [],
    })),
  };
}

const context = {
  sessionId: "session",
  taskId: "task",
  model: "model",
  systemPrompt: "system",
  artifacts: [],
  repositoryContext: { workspaceLabel: "fixture", files: [], symbols: [], diagnostics: [] },
  toolGateway: { allowedTools: [], execute: vi.fn(async () => ({})) },
};

describe("specialist agents", () => {
  it.each(roles)("registers immutable central denials for %s", (role) => {
    const policy = accessPolicyForRole(role);
    expect(policy.applyChanges).toBe(false);
    expect(policy.remoteWrite).toBe(false);
  });

  it.each(roles)("declares capabilities consistent with access for %s", (role) => {
    const policy = accessPolicyForRole(role);
    const capabilities = capabilitiesForRole(role);
    expect(capabilities).toContain("repository_read");
    expect(capabilities.includes("prepare_changes")).toBe(policy.prepareChanges);
  });

  it.each(roles)("executes %s through the injected model runner", async (role) => {
    const model = runner();
    const result = await agent(role, model).execute(task(role), {
      ...context,
      taskId: `task-${role}`,
    });
    expect(result.role).toBe(role);
    expect(model.execute).toHaveBeenCalledOnce();
  });

  it.each(roles)("rejects a task assigned to another role for %s", async (role) => {
    const other = role === "planner" ? "review" : "planner";
    await expect(agent(role, runner()).execute(task(other), context)).rejects.toThrow(/assigned/iu);
  });
});

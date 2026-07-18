import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  SpecialistModelRunner,
  SpecialistModelRequest,
} from "@local-code-agent/agent-specialists";

import { AgentOrchestrator, DEFAULT_ORCHESTRATION_CONFIG } from "../src/index.js";

function payload(type: string): unknown {
  switch (type) {
    case "implementation_plan":
      return { steps: ["analyze"] };
    case "repository_map":
      return { files: ["README.md"], summary: "fixture" };
    case "architecture_report":
      return { summary: "modular", evidence: ["README.md"] };
    case "change_proposal":
      return { changeSetId: "change-set", files: ["src/index.ts"] };
    case "test_plan":
      return { scenarios: ["happy path"], requirements: ["works"] };
    case "verification_report":
      return { status: "passed", evidence: ["tests"] };
    case "security_report":
      return { verdict: "pass", findings: [], reviewedAreas: ["filesystem"], limitations: [] };
    case "review_report":
      return { verdict: "approve", findings: [], planCoverage: [], limitations: [] };
    case "performance_report":
      return { summary: "no regression", evidence: ["analysis"] };
    case "documentation_plan":
      return { files: ["README.md"], changes: ["document feature"] };
    default:
      return { status: "ok", summary: type };
  }
}

class MockSpecialistRunner implements SpecialistModelRunner {
  public async isModelAvailable(): Promise<boolean> {
    return true;
  }

  public async execute(request: SpecialistModelRequest) {
    return {
      taskId: request.task.id,
      role: request.role,
      status: "completed" as const,
      summary: `${request.role} completed`,
      artifacts: request.task.expectedArtifactTypes.map((type) => ({
        type,
        payload: payload(type),
        warnings: [],
      })),
      evidence: [{ type: "file" as const, reference: "README.md" }],
      proposedActions:
        request.role === "implementation"
          ? [
              {
                type: "prepare_change" as const,
                description: "Prepared fixture change",
                files: ["src/index.ts"],
                changeSetReference: "change-set",
              },
            ]
          : [],
      confidence: "high" as const,
      limitations: [],
      warnings: [],
      usage: { steps: 1, toolCalls: 0, commands: 0, contextTokens: 100, durationMs: 1 },
    };
  }
}

const scenarios = Array.from({ length: 20 }, (_, index) => ({
  name: `fixture orchestration ${index + 1}`,
  mode: (["analysis", "implementation", "autonomous"] as const)[index % 3] ?? "analysis",
  includePerformance: index % 5 === 3,
  includeDocumentation: index % 5 === 4,
}));

describe("orchestration integration without Ollama", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orchestration-integration-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(scenarios)("runs $name through both user approval gates", async (scenario) => {
    const orchestrator = new AgentOrchestrator({
      runner: new MockSpecialistRunner(),
      rootDirectory: root,
      dispatcher: async () => ({}),
      repositoryContext: {
        workspaceLabel: "fixture",
        files: ["README.md"],
        symbols: [],
        diagnostics: [],
      },
      config: { ...DEFAULT_ORCHESTRATION_CONFIG, maxAgents: 10 },
    });
    const created = await orchestrator.create({
      task: scenario.name,
      mode: scenario.mode,
      includePerformance: scenario.includePerformance,
      includeDocumentation: scenario.includeDocumentation,
      files: ["README.md"],
    });
    expect(created.state).toBe("awaiting_plan_approval");
    await orchestrator.approvePlan(created.id, "user_cli");
    const report = await orchestrator.run(created.id);
    expect(report.status).toBe("ready_for_approval");
    expect(report.securityReview?.verdict).toBe("pass");
    expect(report.independentReview?.verdict).toBe("approve");
    const completed = await orchestrator.approveFinal(created.id, "user_cli");
    expect(completed.state).toBe("completed");
  });

  it("recovers artifacts and the final report in a new process", async () => {
    const dependencies = {
      runner: new MockSpecialistRunner(),
      rootDirectory: root,
      dispatcher: async () => ({}),
      repositoryContext: {
        workspaceLabel: "fixture",
        files: ["README.md"],
        symbols: [],
        diagnostics: [],
      },
      config: { ...DEFAULT_ORCHESTRATION_CONFIG, maxAgents: 10 },
    };
    const first = new AgentOrchestrator(dependencies);
    const created = await first.create({ task: "recovery", mode: "analysis" });
    await first.approvePlan(created.id, "user_cli");
    await first.run(created.id);

    const recovered = new AgentOrchestrator(dependencies);
    expect((await recovered.recover(created.id)).state).toBe("awaiting_final_approval");
    expect(recovered.report(created.id)?.status).toBe("ready_for_approval");
    expect(recovered.getArtifacts(created.id).length).toBeGreaterThan(0);
    expect((await recovered.approveFinal(created.id, "user_cli")).state).toBe("completed");
  });

  it("requires manual resume after an approved scheduled plan is recovered", async () => {
    const dependencies = {
      runner: new MockSpecialistRunner(),
      rootDirectory: root,
      dispatcher: async () => ({}),
      repositoryContext: {
        workspaceLabel: "fixture",
        files: ["README.md"],
        symbols: [],
        diagnostics: [],
      },
      config: { ...DEFAULT_ORCHESTRATION_CONFIG, maxAgents: 10 },
    };
    const first = new AgentOrchestrator(dependencies);
    const created = await first.create({ task: "interrupted", mode: "analysis" });
    await first.approvePlan(created.id, "user_cli");
    const recovered = new AgentOrchestrator(dependencies);
    expect((await recovered.recover(created.id)).state).toBe("recovery_required");
    expect((await recovered.resume(created.id)).state).toBe("scheduled");
  });
});

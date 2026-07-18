import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { OllamaSpecialistRunner } from "../src/orchestration/ollamaSpecialistRunner.js";

const enabled = process.env.ORCHESTRATION_E2E === "true";

describe.skipIf(!enabled)("optional Ollama orchestration E2E", () => {
  it("runs a small read-only planner request", async () => {
    const config = await loadConfig();
    const runner = new OllamaSpecialistRunner(config);
    const result = await runner.execute({
      role: "planner",
      model: config.orchestrationModelPlanner,
      systemPrompt: "Create a minimal read-only plan.",
      task: {
        id: "ollama_e2e_planner",
        sessionId: "ollama-e2e",
        title: "Analyze fixture",
        description: "Describe the repository structure without changing files.",
        role: "planner",
        accessMode: "read_only",
        files: ["README.md"],
        requirements: ["No changes"],
        expectedArtifactTypes: ["implementation_plan"],
        depth: 1,
        budget: {
          maxSteps: 4,
          maxToolCalls: 0,
          maxCommands: 0,
          maxContextTokens: 8_000,
          maxDurationMs: 120_000,
        },
      },
      artifacts: [],
      repositoryContext: {
        workspaceLabel: "e2e",
        files: ["README.md"],
        symbols: [],
        diagnostics: [],
      },
      toolGateway: { allowedTools: [], execute: async () => ({}) },
    });
    expect(result).toMatchObject({
      taskId: "ollama_e2e_planner",
      role: "planner",
      status: "completed",
    });
  }, 180_000);
});

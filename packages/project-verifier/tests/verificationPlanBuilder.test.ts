import { describe, expect, it } from "vitest";

import {
  VerificationPlanBuilder,
  type DetectedProjectCommand,
  type ProjectCommandDetection,
} from "../src/index.js";

function command(
  id: string,
  category: DetectedProjectCommand["category"],
  allowed = true,
): DetectedProjectCommand {
  return {
    id,
    category,
    displayName: id,
    executable: "tool",
    args: [],
    cwd: "/workspace",
    source: "built_in",
    risk: allowed ? "safe" : "blocked",
    allowed,
    blockedReasons: allowed ? [] : ["blocked"],
    writesFiles: false,
  };
}

function detection(commands: DetectedProjectCommand[]): ProjectCommandDetection {
  return { projectType: ["node"], commands, warnings: [], configurationHash: "hash" };
}

describe("VerificationPlanBuilder", () => {
  it("buduje uporządkowany plan TypeScript", () => {
    const plan = new VerificationPlanBuilder().build(
      detection([
        command("build", "build"),
        command("test", "test"),
        command("types", "typecheck"),
        command("lint", "lint"),
        command("format", "format"),
      ]),
      "workspace",
      ["format_check", "lint", "typecheck", "tests", "build"],
    );
    expect(plan.steps.map((step) => step.category)).toEqual([
      "format",
      "lint",
      "typecheck",
      "test",
      "build",
    ]);
  });

  it.each(["changed_files", "affected_packages", "workspace"] as const)(
    "zachowuje scope %s",
    (scope) => {
      expect(new VerificationPlanBuilder().build(detection([]), scope).scope).toBe(scope);
    },
  );

  it("pomija zablokowane polecenie", () => {
    expect(
      new VerificationPlanBuilder().build(detection([command("test", "test", false)])).steps,
    ).toEqual([]);
  });

  it("raportuje niedostępne etapy", () => {
    const plan = new VerificationPlanBuilder().build(
      detection([command("lint", "lint")]),
      undefined,
      ["lint", "tests", "build"],
    );
    expect(plan.steps).toHaveLength(1);
    expect(plan.skipped.map((item) => item.include)).toEqual(["tests", "build"]);
  });

  it("nie dodaje narzędzi bez dowodów", () => {
    expect(new VerificationPlanBuilder().build(detection([])).steps).toEqual([]);
  });
});

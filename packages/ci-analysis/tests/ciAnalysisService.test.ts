import { describe, expect, it } from "vitest";

import {
  CiAnalysisService,
  ciFailureFingerprint,
  classifyCiFailure,
  parseCiDiagnostics,
} from "../src/index.js";

describe("CI failure classifier", () => {
  it.each([
    ["test_failure", "Unit tests", "Test Suites: 1 failed"],
    ["lint_failure", "Lint", "ESLint found 2 errors"],
    ["typecheck_failure", "Typecheck", "src/a.ts(1,2): error TS2322: bad type"],
    ["build_failure", "Build", "Build failed with compiler error"],
    ["dependency_failure", "Install", "npm ERR ERESOLVE could not resolve dependency"],
    ["environment_failure", "Setup", "command not found: python"],
    ["timeout", "Tests", "The operation timed out"],
    ["permission_failure", "Deploy", "permission denied"],
    ["configuration_failure", "Workflow", "workflow is not valid"],
    ["infrastructure_failure", "Runner", "runner lost: service unavailable"],
    ["cancelled", "Build", "cancelled by user"],
  ] as const)("classifies %s", (category, name, log) => {
    expect(classifyCiFailure(name, log).category).toBe(category);
  });

  it("uses low confidence for unknown output", () => {
    expect(classifyCiFailure("Custom", "unexpected value", "failure")).toEqual({
      category: "unknown",
      confidence: "low",
    });
  });
});

describe("CI diagnostics", () => {
  it.each([
    ["src/a.ts(3,4): error TS2322: bad", "src/a.ts", 3, 4],
    ["src/a.ts:5:6 - error no-unused-vars", "src/a.ts", 5, 6],
    ["    at run (src/a.ts:7:8)", "src/a.ts", 7, 8],
  ] as const)("parses %s", (line, file, row, column) => {
    expect(parseCiDiagnostics(line, "typecheck_failure")[0]).toMatchObject({
      file,
      line: row,
      column,
    });
  });

  it("deduplicates diagnostics by fingerprint", () => {
    expect(
      parseCiDiagnostics("a.ts:1:2: error bad\na.ts:1:2: error bad", "lint_failure"),
    ).toHaveLength(1);
  });

  it("creates a stable normalized fingerprint", () => {
    expect(ciFailureFingerprint({ file: "a.ts", line: 1, message: "Expected 41" })).toBe(
      ciFailureFingerprint({ file: "a.ts", line: 1, message: "Expected 42" }),
    );
  });
});

describe("CI analysis service", () => {
  it.each([
    ["test_failure", "npm test", "fix_code"],
    ["lint_failure", "npm run lint", "fix_code"],
    ["typecheck_failure", "npm run typecheck", "fix_code"],
    ["build_failure", "npm run build", "fix_code"],
    ["infrastructure_failure", undefined, "inspect_infrastructure"],
  ] as const)("builds analysis for %s", (category, command, action) => {
    const logs: Record<string, string> = {
      test_failure: "tests failed\nsrc/a.test.ts:2:3: expected true",
      lint_failure: "eslint error\nsrc/a.ts:2:3: no unused vars",
      typecheck_failure: "src/a.ts(2,3): error TS2322: bad",
      build_failure: "build failed\nsrc/a.ts:2:3: compiler error",
      infrastructure_failure: "runner lost: service unavailable",
    };
    const result = new CiAnalysisService().analyze({
      checkId: "1",
      checkName: category,
      log: logs[category] ?? "",
    });
    expect(result.category).toBe(category);
    expect(result.recommendedAction).toBe(action);
    if (command !== undefined) expect(result.localReproductionCommands).toContain(command);
  });
});

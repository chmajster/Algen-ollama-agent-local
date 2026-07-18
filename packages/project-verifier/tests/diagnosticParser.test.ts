import { describe, expect, it } from "vitest";

import { DiagnosticParser, diagnosticFingerprint } from "../src/index.js";
import type { CommandResult } from "@local-code-agent/command-runner";

function result(output: string, status: CommandResult["status"] = "failed"): CommandResult {
  return {
    id: "x",
    command: { executable: "tool", args: [], cwd: "/workspace", category: "typecheck" },
    status,
    exitCode: status === "success" ? 0 : 1,
    signal: null,
    stdout: output,
    stderr: "",
    outputTruncated: false,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    durationMs: 1,
    outputBytes: Buffer.byteLength(output),
  };
}

describe("DiagnosticParser", () => {
  it("parsuje diagnostykę TypeScript", () => {
    expect(
      new DiagnosticParser().parse(
        "typecheck",
        result("src/a.ts(4,7): error TS2322: Wrong type"),
      )[0],
    ).toMatchObject({
      source: "typecheck",
      file: "src/a.ts",
      line: 4,
      column: 7,
      code: "TS2322",
    });
  });

  it.each([
    ["lint", "src/a.ts:2:3: error no-unused-vars unused", "lint"],
    ["test", "FAILED tests/test_a.py::test_value", "test"],
    ["build", "error[E0308]: mismatched types", "build"],
  ] as const)("parsuje format %s", (category, output, source) => {
    expect(new DiagnosticParser().parse(category, result(output))[0]?.source).toBe(source);
  });

  it("używa fallback dla nieznanego formatu błędu", () => {
    expect(new DiagnosticParser().parse("test", result("Something failed badly"))).toHaveLength(1);
  });

  it("nie tworzy fallback dla sukcesu", () => {
    expect(new DiagnosticParser().parse("test", result("all good", "success"))).toEqual([]);
  });

  it("fingerprint jest stabilny i normalizuje czas", () => {
    const first = diagnosticFingerprint({
      source: "test",
      severity: "error",
      message: "failed in 1.2 s",
    });
    const second = diagnosticFingerprint({
      source: "test",
      severity: "error",
      message: "failed  in  9.8 s",
    });
    expect(first).toBe(second);
  });

  it("usuwa duplikaty diagnostyk", () => {
    const line = "src/a.ts(1,1): error TS1: broken";
    expect(new DiagnosticParser().parse("typecheck", result(`${line}\n${line}`))).toHaveLength(1);
  });
});

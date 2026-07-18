import { describe, expect, it } from "vitest";

import {
  RegressionDetector,
  diagnosticFingerprint,
  type VerificationBaseline,
  type VerificationDiagnostic,
} from "../src/index.js";

function diagnostic(
  message: string,
  severity: VerificationDiagnostic["severity"] = "error",
  line = 1,
): VerificationDiagnostic {
  const base = { source: "typecheck" as const, severity, file: "src/a.ts", line, message };
  return { ...base, fingerprint: diagnosticFingerprint(base) };
}

function baseline(diagnostics: VerificationDiagnostic[]): VerificationBaseline {
  return {
    id: "base",
    createdAt: new Date(0).toISOString(),
    workspaceHash: "hash",
    steps: [],
    diagnostics,
  };
}

describe("RegressionDetector", () => {
  const detector = new RegressionDetector();

  it("klasyfikuje identyczny błąd jako pre-existing", () => {
    const item = diagnostic("broken");
    expect(detector.compare([item], baseline([item]))).toMatchObject({
      preExisting: [item],
      regressions: [],
    });
  });

  it("wykrywa nowy błąd", () => {
    const item = diagnostic("new");
    expect(detector.compare([item], baseline([])).regressions).toEqual([item]);
  });

  it("wykrywa rozwiązany błąd", () => {
    const item = diagnostic("old");
    expect(detector.compare([], baseline([item])).resolved).toEqual([item]);
  });

  it("wykrywa zmieniony komunikat w tej samej lokalizacji", () => {
    const old = diagnostic("old");
    const current = diagnostic("new");
    expect(detector.compare([current], baseline([old]))).toMatchObject({
      changed: [current],
      regressions: [current],
    });
  });

  it("nie miesza tych samych komunikatów w innych liniach", () => {
    const old = diagnostic("broken", "error", 1);
    const current = diagnostic("broken", "error", 2);
    expect(detector.compare([current], baseline([old])).regressions).toEqual([current]);
  });

  it("bez baseline traktuje diagnostyki jako nowe", () => {
    const item = diagnostic("broken");
    expect(detector.compare([item]).regressions).toEqual([item]);
  });

  it("obsługuje brak regresji", () => {
    expect(detector.compare([], baseline([]))).toMatchObject({
      regressions: [],
      preExisting: [],
      resolved: [],
    });
  });
});

import { describe, expect, it } from "vitest";

import { DiffService } from "../src/index.js";

describe("DiffService", () => {
  it("generuje unified diff zmienionego pliku z kontekstem", () => {
    const result = new DiffService(10_000).modified(
      "src/a.ts",
      "one\ntwo\nthree\nfour\nfive\n",
      "one\ntwo\nTHREE\nfour\nfive\n",
    );
    expect(result.diff).toContain("--- a/src/a.ts");
    expect(result.diff).toContain("+++ b/src/a.ts");
    expect(result.diff).toContain("-three");
    expect(result.diff).toContain("+THREE");
    expect(result).toMatchObject({ additions: 1, deletions: 1, truncated: false });
  });

  it("generuje diff nowego pliku", () => {
    const result = new DiffService(10_000).created("src/new.ts", "export {};\n");
    expect(result.diff).toContain("--- /dev/null");
    expect(result.diff).toContain("+++ b/src/new.ts");
    expect(result.additions).toBe(1);
  });

  it("generuje diff usuniętego pliku", () => {
    const result = new DiffService(10_000).deleted("src/old.ts", "old\n");
    expect(result.diff).toContain("--- a/src/old.ts");
    expect(result.diff).toContain("+++ /dev/null");
    expect(result.deletions).toBe(1);
  });

  it("przedstawia przeniesienie jako rename 100%", () => {
    const result = new DiffService(10_000).moved("src/old.ts", "lib/new.ts");
    expect(result.diff).toBe(
      "similarity index 100%\nrename from src/old.ts\nrename to lib/new.ts\n",
    );
    expect(result).toMatchObject({ additions: 0, deletions: 0 });
  });

  it("normalizuje separatory ścieżek do /", () => {
    const result = new DiffService(10_000).created("src\\nested\\a.ts", "a\n");
    expect(result.path).toBe("src/nested/a.ts");
    expect(result.diff).not.toContain("\\");
  });

  it("zwraca strukturalne podsumowanie zamiast uciętego diffu", () => {
    const result = new DiffService(80).modified("a.ts", "a\n".repeat(30), "b\n".repeat(30));
    expect(result.truncated).toBe(true);
    expect(result.diff).toContain("przekracza limit 80");
    expect(result.diff).not.toContain("@@");
  });

  it("ogranicza również połączony diff", () => {
    const service = new DiffService(100);
    const combined = service.combine([
      service.created("a.ts", "a\n".repeat(10)),
      service.created("b.ts", "b\n".repeat(10)),
    ]);
    expect(combined.truncated).toBe(true);
    expect(combined.diff).toContain("Liczba plików: 2");
  });
});

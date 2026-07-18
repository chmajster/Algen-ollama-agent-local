import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BaselineInvalidError, BaselineService, type VerificationResult } from "../src/index.js";

describe("BaselineService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baseline-"));
    await writeFile(join(root, "a.ts"), "a\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function result(): VerificationResult {
    const now = new Date().toISOString();
    return {
      id: "verification",
      status: "passed",
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      scope: "workspace",
      steps: [],
      diagnostics: [],
      regressions: [],
      preExistingIssues: [],
      resolvedIssues: [],
      summary: { passed: 0, failed: 0, skipped: 0, unavailable: 0 },
    };
  }

  it("tworzy i odczytuje baseline", async () => {
    const service = new BaselineService(root);
    const created = await service.create(result());
    expect(created.fileHashes).toHaveProperty("a.ts");
    await expect(service.latest()).resolves.toMatchObject({ id: created.id });
  });

  it("nie zapisuje pełnego stdout i stderr kroków", async () => {
    const value = result();
    value.steps.push({
      commandId: "test",
      category: "test",
      displayName: "test",
      status: "passed",
      exitCode: 0,
      durationMs: 1,
      diagnostics: [],
      stdoutExcerpt: "SECRET OUTPUT",
      stderrExcerpt: "ERROR OUTPUT",
      outputTruncated: false,
    });
    const baseline = await new BaselineService(root).create(value);
    expect(baseline.steps[0]).toMatchObject({ stdoutExcerpt: "", stderrExcerpt: "" });
  });

  it("wykrywa nieaktualny baseline", async () => {
    const service = new BaselineService(root);
    await service.create(result());
    await writeFile(join(root, "a.ts"), "changed\n");
    await expect(service.latest()).rejects.toBeInstanceOf(BaselineInvalidError);
  });

  it("zezwala na jawnie wskazany plik zmieniony przez agenta", async () => {
    const service = new BaselineService(root);
    await service.create(result());
    await writeFile(join(root, "a.ts"), "changed\n");
    await expect(service.latest(["a.ts"])).resolves.toBeDefined();
  });

  it("wykrywa nowy plik spoza ChangeSet", async () => {
    const service = new BaselineService(root);
    await service.create(result());
    await writeFile(join(root, "external.ts"), "external\n");
    await expect(service.latest(["a.ts"])).rejects.toBeInstanceOf(BaselineInvalidError);
  });

  it("zwraca undefined bez baseline", async () => {
    await expect(new BaselineService(root).latest()).resolves.toBeUndefined();
  });
});

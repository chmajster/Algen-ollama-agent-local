import { describe, expect, it } from "vitest";

import type { ApplyChangeSetResult, ChangeService } from "@local-code-agent/change-engine";
import type {
  ProjectVerifier,
  RunVerificationInput,
  VerificationResult,
} from "@local-code-agent/project-verifier";

import { VerificationCoordinator } from "../src/verificationCoordinator.js";

function report(status: VerificationResult["status"]): VerificationResult {
  return {
    id: crypto.randomUUID(),
    status,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
    scope: "affected_packages",
    steps: [],
    diagnostics: [],
    regressions: [],
    preExistingIssues: [],
    resolvedIssues: [],
    summary: {
      passed: status === "passed" ? 1 : 0,
      failed: status === "failed" ? 1 : 0,
      skipped: 0,
      unavailable: 0,
    },
  };
}

class FakeVerifier {
  public readonly inputs: RunVerificationInput[] = [];
  public repairAttempts = 0;

  public constructor(private readonly reports: VerificationResult[]) {}

  public async verify(input: RunVerificationInput): Promise<VerificationResult> {
    this.inputs.push(input);
    const next = this.reports.shift();
    if (next === undefined) throw new Error("Brak raportu testowego.");
    return next;
  }

  public recordRepairAttempt(): void {
    this.repairAttempts += 1;
  }
}

class FakeChanges {
  public readonly rollbacks: string[] = [];

  public async getCurrentChangeSet() {
    return {
      id: "change-set",
      status: "applied" as const,
      operations: [
        {
          id: "operation",
          type: "apply_patch" as const,
          path: "src/a.ts",
          reason: "test",
          additions: 1,
          deletions: 1,
        },
      ],
      totals: {
        filesChanged: 1,
        filesCreated: 0,
        filesDeleted: 0,
        filesMoved: 0,
        additions: 1,
        deletions: 1,
      },
    };
  }

  public async rollbackChangeSet(changeSetId: string) {
    this.rollbacks.push(changeSetId);
    return { changeSetId, checkpointId: "checkpoint", restoredFiles: ["src/a.ts"] };
  }
}

function applied(): ApplyChangeSetResult {
  return {
    changeSetId: "change-set",
    status: "applied",
    checkpointId: "checkpoint",
    preview: {
      changeSetId: "change-set",
      operations: [],
      diff: "",
      fileDiffs: {},
      warnings: [],
      conflicts: [],
      totals: {
        filesChanged: 1,
        filesCreated: 0,
        filesDeleted: 0,
        filesMoved: 0,
        additions: 1,
        deletions: 1,
      },
      canApply: true,
      diffTruncated: false,
    },
  };
}

function coordinator(
  verifier: FakeVerifier,
  changes: FakeChanges,
  options: { rollback?: boolean; max?: number; enabled?: boolean } = {},
): VerificationCoordinator {
  return new VerificationCoordinator(
    verifier as unknown as ProjectVerifier,
    changes as unknown as ChangeService,
    {
      enabled: options.enabled ?? true,
      verifyAfterApply: true,
      rollbackOnFailure: options.rollback ?? false,
      maxRepairAttempts: options.max ?? 3,
      scope: "affected_packages",
    },
  );
}

describe("VerificationCoordinator", () => {
  it("automatycznie weryfikuje zastosowany ChangeSet i przekazuje zmienione pliki", async () => {
    const verifier = new FakeVerifier([report("passed")]);
    const changes = new FakeChanges();
    const service = coordinator(verifier, changes);

    await expect(service.afterApply(applied())).resolves.toMatchObject({ status: "passed" });
    expect(verifier.inputs[0]).toMatchObject({
      scope: "affected_packages",
      changedFiles: ["src/a.ts"],
    });
    expect(service.snapshot()).toMatchObject({ repairAttempts: 0, rolledBack: false });
  });

  it("liczy próby naprawy i blokuje następną po osiągnięciu limitu", async () => {
    const verifier = new FakeVerifier([report("failed"), report("failed")]);
    const service = coordinator(verifier, new FakeChanges(), { max: 1 });

    await service.afterApply(applied());
    await service.beforeApply();
    await service.afterApply(applied());

    expect(service.snapshot()).toMatchObject({
      repairAttempts: 1,
      maxRepairAttemptsReached: true,
    });
    expect(verifier.repairAttempts).toBe(1);
    await expect(service.beforeApply()).rejects.toMatchObject({ code: "REPAIR_ATTEMPT_LIMIT" });
  });

  it("wykonuje kontrolowany rollback po błędzie, gdy opcja jest włączona", async () => {
    const verifier = new FakeVerifier([report("failed")]);
    const changes = new FakeChanges();
    const service = coordinator(verifier, changes, { rollback: true });

    await service.afterApply(applied());

    expect(changes.rollbacks).toEqual(["change-set"]);
    expect(service.snapshot()).toMatchObject({ rolledBack: true, report: { status: "failed" } });
  });

  it("nie uruchamia procesu, gdy automatyczna weryfikacja jest wyłączona", async () => {
    const verifier = new FakeVerifier([report("passed")]);
    const service = coordinator(verifier, new FakeChanges(), { enabled: false });

    await expect(service.afterApply(applied())).resolves.toBeUndefined();
    expect(verifier.inputs).toHaveLength(0);
  });
});

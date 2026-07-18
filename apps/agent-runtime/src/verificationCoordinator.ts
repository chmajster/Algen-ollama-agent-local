import type { ApplyChangeSetResult, ChangeService } from "@local-code-agent/change-engine";
import type {
  ProjectVerifier,
  VerificationResult,
  VerificationScope,
} from "@local-code-agent/project-verifier";
import { RepairAttemptLimitError } from "@local-code-agent/project-verifier";

export interface VerificationCoordinatorOptions {
  enabled: boolean;
  verifyAfterApply: boolean;
  rollbackOnFailure: boolean;
  maxRepairAttempts: number;
  scope: VerificationScope;
}

export interface VerificationSessionSnapshot {
  report?: VerificationResult;
  repairAttempts: number;
  maxRepairAttemptsReached: boolean;
  rolledBack: boolean;
}

export class VerificationCoordinator {
  private lastReport: VerificationResult | undefined;
  private awaitingRepair = false;
  private repairAttempts = 0;
  private maxReached = false;
  private rolledBack = false;

  public constructor(
    private readonly verifier: ProjectVerifier,
    private readonly changes: ChangeService,
    private readonly options: VerificationCoordinatorOptions,
  ) {}

  public async beforeApply(): Promise<void> {
    if (this.awaitingRepair && this.repairAttempts >= this.options.maxRepairAttempts) {
      this.maxReached = true;
      throw new RepairAttemptLimitError();
    }
  }

  private async changedFiles(): Promise<string[]> {
    const current = await this.changes.getCurrentChangeSet();
    return current.operations
      .flatMap((operation) =>
        operation.type === "move_file"
          ? [operation.sourcePath ?? "", operation.destinationPath ?? ""]
          : [operation.path ?? ""],
      )
      .filter(Boolean);
  }

  public async afterApply(result: ApplyChangeSetResult): Promise<VerificationResult | undefined> {
    if (result.status !== "applied" || !this.options.enabled || !this.options.verifyAfterApply)
      return undefined;
    if (this.awaitingRepair) {
      this.repairAttempts += 1;
      this.verifier.recordRepairAttempt();
    }
    const report = await this.verifier.verify({
      scope: this.options.scope,
      reason: "Automatyczna weryfikacja po zastosowaniu ChangeSet.",
      changedFiles: await this.changedFiles(),
    });
    this.lastReport = report;
    this.awaitingRepair = report.status === "failed";
    if (this.awaitingRepair && this.repairAttempts >= this.options.maxRepairAttempts) {
      this.maxReached = true;
    }
    if (this.awaitingRepair && this.options.rollbackOnFailure) {
      await this.changes.rollbackChangeSet(result.changeSetId);
      this.rolledBack = true;
      this.awaitingRepair = false;
    }
    return report;
  }

  public snapshot(): VerificationSessionSnapshot {
    return {
      ...(this.lastReport === undefined ? {} : { report: structuredClone(this.lastReport) }),
      repairAttempts: this.repairAttempts,
      maxRepairAttemptsReached: this.maxReached,
      rolledBack: this.rolledBack,
    };
  }
}

import { createHash, randomUUID } from "node:crypto";
import { relative } from "node:path";

import {
  UnsupportedProjectCommandError,
  type CommandRunner,
} from "@local-code-agent/command-runner";

import { BaselineService } from "./baselineService.js";
import { DiagnosticParser } from "./diagnosticParser.js";
import { BaselineInvalidError, VerificationUnavailableError } from "./errors.js";
import { ProjectScriptDetector } from "./projectScriptDetector.js";
import { RegressionDetector } from "./regressionDetector.js";
import { TestResultParser } from "./testResultParser.js";
import { VerificationPlanBuilder } from "./verificationPlanBuilder.js";
import type {
  DetectedProjectCommand,
  ProjectCommandCatalog,
  ProjectCommandDetection,
  ProjectCommandRunResult,
  ProjectVerifierOptions,
  ProjectVerifierStatistics,
  RunVerificationInput,
  VerificationResult,
  VerificationStepResult,
} from "./verifierTypes.js";

function stepStatus(
  status: ProjectCommandRunResult["result"]["status"],
): VerificationStepResult["status"] {
  if (status === "success") return "passed";
  if (status === "timeout") return "timeout";
  if (status === "aborted") return "aborted";
  if (status === "spawn_error" || status === "blocked") return "unavailable";
  return "failed";
}

export class ProjectVerifier {
  private readonly detector: ProjectScriptDetector;
  private readonly plans = new VerificationPlanBuilder();
  private readonly diagnostics = new DiagnosticParser();
  private readonly tests = new TestResultParser();
  private readonly regressions = new RegressionDetector();
  private readonly baselines: BaselineService;
  private readonly reports = new Map<string, VerificationResult>();
  private lastReportId: string | undefined;
  private lastVerificationFingerprint: string | undefined;
  private statistics: ProjectVerifierStatistics = {
    commandsDetected: 0,
    verificationRuns: 0,
    verificationSteps: 0,
    verificationFailures: 0,
    regressionsDetected: 0,
    preExistingIssuesDetected: 0,
    repairAttempts: 0,
  };

  public constructor(
    private readonly options: ProjectVerifierOptions,
    private readonly runner: CommandRunner,
  ) {
    this.detector = new ProjectScriptDetector(options, runner.getResolver());
    this.baselines = new BaselineService(options.workspaceRoot);
  }

  public async detectProjectCommands(): Promise<ProjectCommandDetection> {
    const catalog = await this.detector.detect();
    this.statistics.commandsDetected = catalog.detection.commands.length;
    return catalog.detection;
  }

  private async catalog(): Promise<ProjectCommandCatalog> {
    const catalog = await this.detector.detect();
    this.statistics.commandsDetected = catalog.detection.commands.length;
    return catalog;
  }

  public async runProjectCommand(
    commandId: string,
    reason: string,
    signal?: AbortSignal,
  ): Promise<ProjectCommandRunResult> {
    if (reason.trim().length < 3)
      throw new VerificationUnavailableError("Polecenie wymaga konkretnego powodu.");
    const catalog = await this.catalog();
    const view = catalog.detection.commands.find((command) => command.id === commandId);
    const spec = catalog.specs.get(commandId);
    if (view === undefined || spec === undefined || !view.allowed) {
      throw new UnsupportedProjectCommandError(
        "Identyfikator nie wskazuje aktualnego dozwolonego polecenia.",
        { commandId },
      );
    }
    const result = await this.runner.run(
      spec,
      { accessMode: this.options.accessMode, reason },
      signal,
    );
    const diagnostics = this.diagnostics.parse(spec.category, result);
    return {
      command: view,
      result,
      diagnostics,
      ...(spec.category === "test"
        ? { testSummary: this.tests.parse(result.stdout, result.stderr) }
        : {}),
    };
  }

  public async runCategory(
    category: DetectedProjectCommand["category"],
    reason: string,
    signal?: AbortSignal,
  ): Promise<ProjectCommandRunResult> {
    const detection = await this.detectProjectCommands();
    const candidates = detection.commands.filter(
      (command) =>
        command.category === category &&
        command.allowed &&
        (!command.writesFiles || this.options.accessMode === "write"),
    );
    const command = candidates.find((item) => !item.writesFiles) ?? candidates[0];
    if (command === undefined) throw new UnsupportedProjectCommandError(undefined, { category });
    return this.runProjectCommand(command.id, reason, signal);
  }

  private scopedDetection(
    detection: ProjectCommandCatalog["detection"],
    input: RunVerificationInput,
  ): ProjectCommandCatalog["detection"] {
    // Bez pełnego grafu zależności monorepo zakres affected_packages musi bezpiecznie
    // rozszerzyć się do workspace. Tylko jawny changed_files może zawęzić pakiety.
    if (input.scope !== "changed_files" || input.changedFiles === undefined) return detection;
    const changed = input.changedFiles.map((path) => path.replaceAll("\\", "/"));
    const commands = detection.commands.filter((command) => {
      const packagePath = relative(this.options.workspaceRoot, command.cwd).replaceAll("\\", "/");
      if (packagePath === "" || packagePath === ".") return true;
      return changed.some((path) => path === packagePath || path.startsWith(`${packagePath}/`));
    });
    return { ...detection, commands };
  }

  private async verificationFingerprint(input: RunVerificationInput): Promise<string> {
    const files = await this.baselines.snapshot();
    return createHash("sha256")
      .update(
        JSON.stringify({
          files,
          scope: input.scope ?? "affected_packages",
          include: input.include ?? ["tests", "lint", "typecheck", "build"],
          changedFiles: [...(input.changedFiles ?? [])]
            .map((path) => path.replaceAll("\\", "/"))
            .sort(),
        }),
      )
      .digest("hex");
  }

  private async verifyInternal(
    input: RunVerificationInput,
    compareBaseline: boolean,
  ): Promise<VerificationResult> {
    const startedAt = new Date();
    const catalog = await this.catalog();
    const plan = this.plans.build(
      this.scopedDetection(catalog.detection, input),
      input.scope,
      input.include,
    );
    const steps: VerificationStepResult[] = [];
    for (const command of plan.steps) {
      if (input.signal?.aborted === true) break;
      try {
        const run = await this.runProjectCommand(command.id, input.reason, input.signal);
        steps.push({
          commandId: command.id,
          category: command.category,
          displayName: command.displayName,
          status: stepStatus(run.result.status),
          exitCode: run.result.exitCode,
          durationMs: run.result.durationMs,
          diagnostics: run.diagnostics,
          ...(run.testSummary === undefined ? {} : { testSummary: run.testSummary }),
          stdoutExcerpt: run.result.stdout,
          stderrExcerpt: run.result.stderr,
          outputTruncated: run.result.outputTruncated,
        });
      } catch (error: unknown) {
        if (input.signal?.aborted ?? false) break;
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "COMMAND_LIMIT_EXCEEDED"
        ) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        steps.push({
          commandId: command.id,
          category: command.category,
          displayName: command.displayName,
          status: "unavailable",
          exitCode: null,
          durationMs: 0,
          diagnostics: [],
          stdoutExcerpt: "",
          stderrExcerpt: message,
          outputTruncated: false,
        });
      }
    }
    const diagnostics = steps.flatMap((step) => step.diagnostics);
    let baseline;
    if (compareBaseline && this.options.baselineEnabled) {
      try {
        baseline = await this.baselines.latest(input.changedFiles);
      } catch (error: unknown) {
        if (!(error instanceof BaselineInvalidError)) throw error;
      }
    }
    const comparison = this.regressions.compare(diagnostics, baseline);
    const passed = steps.filter((step) => step.status === "passed").length;
    const failed = steps.filter((step) => ["failed", "timeout"].includes(step.status)).length;
    const unavailable =
      steps.filter((step) => step.status === "unavailable").length + plan.skipped.length;
    const skipped = steps.filter((step) => step.status === "skipped").length;
    const aborted =
      input.signal?.aborted === true || steps.some((step) => step.status === "aborted");
    const status: VerificationResult["status"] = aborted
      ? "aborted"
      : plan.steps.length === 0
        ? "unavailable"
        : failed > 0
          ? "failed"
          : unavailable > 0
            ? "partial"
            : "passed";
    const finishedAt = new Date();
    const result: VerificationResult = {
      id: randomUUID(),
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      scope: plan.scope,
      steps,
      diagnostics,
      regressions: comparison.regressions,
      preExistingIssues: comparison.preExisting,
      resolvedIssues: comparison.resolved,
      summary: { passed, failed, skipped, unavailable },
    };
    this.statistics.verificationRuns += 1;
    this.statistics.verificationSteps += steps.length;
    if (status === "failed") this.statistics.verificationFailures += 1;
    this.statistics.regressionsDetected += comparison.regressions.length;
    this.statistics.preExistingIssuesDetected += comparison.preExisting.length;
    this.reports.set(result.id, result);
    this.lastReportId = result.id;
    return result;
  }

  public async verify(input: RunVerificationInput): Promise<VerificationResult> {
    const fingerprint = await this.verificationFingerprint(input);
    if (fingerprint === this.lastVerificationFingerprint) {
      throw new VerificationUnavailableError(
        "Identyczna weryfikacja została już wykonana i pliki projektu nie zmieniły się.",
        { reason: "NO_CHANGES_SINCE_VERIFICATION" },
      );
    }
    const result = await this.verifyInternal(input, true);
    this.lastVerificationFingerprint = await this.verificationFingerprint(input);
    return result;
  }

  public async createBaseline(
    input: RunVerificationInput,
  ): Promise<{ baselineId: string; result: VerificationResult }> {
    const result = await this.verifyInternal(input, false);
    const baseline = await this.baselines.create(result);
    this.lastVerificationFingerprint = await this.verificationFingerprint(input);
    return { baselineId: baseline.id, result };
  }

  public getReport(id?: string): VerificationResult | undefined {
    const key = id ?? this.lastReportId;
    if (key === undefined) return undefined;
    const report = this.reports.get(key);
    return report === undefined ? undefined : structuredClone(report);
  }

  public recordRepairAttempt(): void {
    this.statistics.repairAttempts += 1;
  }

  public getStatistics(): ProjectVerifierStatistics {
    return { ...this.statistics };
  }
}

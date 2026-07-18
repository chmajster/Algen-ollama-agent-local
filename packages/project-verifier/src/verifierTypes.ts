import type {
  CommandCategory,
  CommandResult,
  CommandSpec,
  PackageManagerDetection,
} from "@local-code-agent/command-runner";

export type VerificationScope = "changed_files" | "affected_packages" | "workspace";
export type VerificationInclude = "tests" | "lint" | "typecheck" | "build" | "format_check";

export interface DetectedProjectCommand {
  id: string;
  category: Exclude<CommandCategory, "version" | "custom">;
  displayName: string;
  executable: string;
  args: string[];
  cwd: string;
  source: string;
  risk: string;
  allowed: boolean;
  blockedReasons: string[];
  writesFiles: boolean;
}

export interface ProjectCommandDetection {
  projectType: string[];
  packageManager?: PackageManagerDetection;
  commands: DetectedProjectCommand[];
  warnings: string[];
  configurationHash: string;
}

export interface VerificationDiagnostic {
  source: "test" | "lint" | "typecheck" | "build" | "format";
  severity: "error" | "warning" | "info";
  code?: string;
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  fingerprint: string;
}

export interface TestSummary {
  testSuites?: number;
  testsTotal?: number;
  testsPassed?: number;
  testsFailed?: number;
  testsSkipped?: number;
}

export interface VerificationStepResult {
  commandId: string;
  category: DetectedProjectCommand["category"];
  displayName: string;
  status: "passed" | "failed" | "timeout" | "aborted" | "skipped" | "unavailable";
  exitCode: number | null;
  durationMs: number;
  diagnostics: VerificationDiagnostic[];
  testSummary?: TestSummary;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  outputTruncated: boolean;
}

export interface VerificationResult {
  id: string;
  status: "passed" | "failed" | "partial" | "unavailable" | "aborted";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scope: VerificationScope;
  steps: VerificationStepResult[];
  diagnostics: VerificationDiagnostic[];
  regressions: VerificationDiagnostic[];
  preExistingIssues: VerificationDiagnostic[];
  resolvedIssues: VerificationDiagnostic[];
  summary: { passed: number; failed: number; skipped: number; unavailable: number };
}

export interface VerificationBaseline {
  id: string;
  createdAt: string;
  workspaceHash: string;
  gitHead?: string;
  gitStatusHash?: string;
  steps: VerificationStepResult[];
  diagnostics: VerificationDiagnostic[];
  fileHashes?: Record<string, string>;
}

export type DiagnosticClassification = "new" | "pre_existing" | "resolved" | "changed" | "unknown";

export interface RegressionComparison {
  regressions: VerificationDiagnostic[];
  preExisting: VerificationDiagnostic[];
  resolved: VerificationDiagnostic[];
  changed: VerificationDiagnostic[];
}

export interface VerificationPlan {
  scope: VerificationScope;
  steps: DetectedProjectCommand[];
  skipped: Array<{ include: VerificationInclude; reason: string }>;
}

export interface RunVerificationInput {
  scope?: VerificationScope;
  include?: VerificationInclude[];
  reason: string;
  changedFiles?: string[];
  signal?: AbortSignal;
}

export interface ProjectVerifierOptions {
  workspaceRoot: string;
  commandTimeoutMs: number;
  testTimeoutMs: number;
  buildTimeoutMs: number;
  baselineEnabled: boolean;
  accessMode: "readonly" | "preview" | "write";
}

export interface ProjectVerifierStatistics {
  commandsDetected: number;
  verificationRuns: number;
  verificationSteps: number;
  verificationFailures: number;
  regressionsDetected: number;
  preExistingIssuesDetected: number;
  repairAttempts: number;
}

export interface ProjectCommandCatalog {
  detection: ProjectCommandDetection;
  specs: ReadonlyMap<string, CommandSpec>;
}

export interface ProjectCommandRunResult {
  command: DetectedProjectCommand;
  result: CommandResult;
  diagnostics: VerificationDiagnostic[];
  testSummary?: TestSummary;
}

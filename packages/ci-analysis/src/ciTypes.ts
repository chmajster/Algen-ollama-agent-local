export type CiFailureCategory =
  | "test_failure"
  | "lint_failure"
  | "typecheck_failure"
  | "build_failure"
  | "dependency_failure"
  | "environment_failure"
  | "timeout"
  | "permission_failure"
  | "configuration_failure"
  | "infrastructure_failure"
  | "cancelled"
  | "unknown";

export interface CiDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  fingerprint: string;
}

export interface CiFailureAnalysis {
  checkId: string;
  category: CiFailureCategory;
  confidence: "high" | "medium" | "low";
  summary: string;
  diagnostics: CiDiagnostic[];
  likelyRelatedFiles: string[];
  localReproductionCommands: string[];
  environmentalDifferences: string[];
  recommendedAction:
    "fix_code" | "fix_configuration" | "rerun" | "inspect_infrastructure" | "manual_review";
}

export interface SanitizedCiLog {
  content: string;
  truncated: boolean;
  redactions: number;
  removedDuplicateLines: number;
  errorBlocks: string[];
  promptInjectionWarning: boolean;
}

export interface CiAnalysisInput {
  checkId: string;
  checkName: string;
  log: string;
  conclusion?: string;
  maxLogChars?: number;
}

export type SpecialistRole =
  | "planner"
  | "repository_explorer"
  | "architecture"
  | "implementation"
  | "test"
  | "review"
  | "security"
  | "performance"
  | "documentation";

export type AgentCapability =
  | "repository_read"
  | "semantic_search"
  | "lsp_read"
  | "prepare_changes"
  | "verification"
  | "command_execution"
  | "mcp_read"
  | "remote_read"
  | "architecture_analysis"
  | "security_analysis"
  | "review"
  | "documentation";

export interface SpecialistAccessPolicy {
  repositoryRead: boolean;
  semanticSearch: boolean;
  lspRead: boolean;
  prepareChanges: boolean;
  applyChanges: false;
  runVerification: boolean;
  executeCommands: boolean;
  useMcp: boolean;
  remoteRead: boolean;
  remoteWrite: false;
  allowedFilePatterns?: string[];
}

export interface SpecialistTask {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  role: SpecialistRole;
  accessMode: "read_only" | "prepare_changes" | "verification";
  files: string[];
  requirements: string[];
  expectedArtifactTypes: string[];
  depth: number;
  budget: {
    maxSteps: number;
    maxToolCalls: number;
    maxCommands: number;
    maxContextTokens: number;
    maxDurationMs: number;
  };
}

export interface SpecialistInputArtifact {
  id: string;
  type: string;
  producerTaskId: string;
  version: number;
  payload: unknown;
  warnings: string[];
}

export interface SpecialistToolGateway {
  readonly allowedTools: readonly string[];
  execute(name: string, arguments_: unknown): Promise<unknown>;
}

export interface SpecialistExecutionContext {
  sessionId: string;
  taskId: string;
  model: string;
  systemPrompt: string;
  artifacts: SpecialistInputArtifact[];
  repositoryContext: {
    workspaceLabel: string;
    files: string[];
    symbols: string[];
    diagnostics: string[];
  };
  toolGateway: SpecialistToolGateway;
  signal?: AbortSignal;
}

export interface SharedArtifactDraft {
  type: string;
  payload: unknown;
  confidence?: number;
  warnings: string[];
}

export interface ProposedAction {
  type:
    | "read_context"
    | "prepare_change"
    | "run_verification"
    | "request_replan"
    | "request_user_decision"
    | "no_action";
  description: string;
  files?: string[];
  changeSetReference?: string;
}

export interface SpecialistResult {
  taskId: string;
  role: SpecialistRole;
  status: "completed" | "failed" | "blocked" | "needs_clarification" | "security_stop";
  summary: string;
  artifacts: SharedArtifactDraft[];
  evidence: Array<{
    type: "file" | "symbol" | "diagnostic" | "command" | "verification" | "commit";
    reference: string;
  }>;
  proposedActions: ProposedAction[];
  confidence: "high" | "medium" | "low";
  limitations: string[];
  warnings: string[];
  usage?: {
    steps: number;
    toolCalls: number;
    commands: number;
    contextTokens: number;
    durationMs: number;
  };
}

export interface IndependentReviewReport {
  verdict: "approve" | "changes_required" | "manual_review";
  findings: Array<{
    id: string;
    severity: "critical" | "high" | "medium" | "low" | "info";
    category:
      | "correctness"
      | "regression"
      | "maintainability"
      | "test_coverage"
      | "architecture"
      | "performance"
      | "documentation";
    path?: string;
    line?: number;
    message: string;
    evidence: string[];
    suggestedAction?: string;
  }>;
  planCoverage: Array<{
    requirement: string;
    status: "covered" | "partial" | "missing" | "not_applicable";
    evidence: string[];
  }>;
  limitations: string[];
}

export interface SecurityReviewReport {
  verdict: "pass" | "warning" | "block";
  findings: Array<{
    id: string;
    severity: "critical" | "high" | "medium" | "low";
    category:
      | "authentication"
      | "authorization"
      | "input_validation"
      | "injection"
      | "secrets"
      | "cryptography"
      | "filesystem"
      | "process_execution"
      | "network"
      | "supply_chain"
      | "prompt_injection"
      | "other";
    path?: string;
    line?: number;
    message: string;
    evidence: string[];
    remediation?: string;
  }>;
  reviewedAreas: string[];
  limitations: string[];
}

export interface SpecialistModelRequest {
  role: SpecialistRole;
  model: string;
  systemPrompt: string;
  task: SpecialistTask;
  artifacts: SpecialistInputArtifact[];
  repositoryContext: SpecialistExecutionContext["repositoryContext"];
  toolGateway: SpecialistToolGateway;
  signal?: AbortSignal;
}

export interface SpecialistModelRunner {
  execute(request: SpecialistModelRequest): Promise<SpecialistResult>;
  isModelAvailable?(model: string): Promise<boolean>;
}

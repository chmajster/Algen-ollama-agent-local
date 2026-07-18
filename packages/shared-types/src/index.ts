export type AgentMessageRole = "system" | "user" | "assistant" | "tool";

export interface ModelToolCall {
  id?: string;
  function: {
    name: string;
    arguments: unknown;
  };
}

export interface AgentMessage {
  role: AgentMessageRole;
  content: string;
  toolCalls?: ModelToolCall[];
  toolName?: string;
}

export interface OllamaToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelChatRequest {
  messages: AgentMessage[];
  tools: OllamaToolDefinition[];
  signal?: AbortSignal;
}

export interface ModelChatResponse {
  message: AgentMessage;
}

export interface AgentModelClient {
  checkAvailability(signal?: AbortSignal): Promise<void>;
  chat(request: ModelChatRequest): Promise<ModelChatResponse>;
}

export interface AgentRunOptions {
  task: string;
  maxSteps?: number;
  signal?: AbortSignal;
}

export type AgentFinishReason =
  | "completed"
  | "preview_completed"
  | "changes_pending_confirmation"
  | "changes_applied"
  | "verification_passed"
  | "verification_failed"
  | "verification_unavailable"
  | "changes_rejected"
  | "rolled_back"
  | "max_steps"
  | "max_repair_attempts"
  | "command_limit_reached"
  | "aborted"
  | "error";

export type AgentPhase =
  | "analysis"
  | "baseline"
  | "planning"
  | "editing"
  | "preview"
  | "confirmation"
  | "applying"
  | "verification"
  | "repair"
  | "completed"
  | "failed"
  | "rolled_back";

export interface AgentChangeSummary {
  changeSetId: string;
  mode: "readonly" | "preview" | "write";
  filesChanged: number;
  filesCreated: number;
  filesDeleted: number;
  filesMoved: number;
  additions: number;
  deletions: number;
  checkpointId?: string;
}

export interface AgentWriteStatistics {
  patchesPrepared: number;
  patchesApplied: number;
  filesCreated: number;
  filesDeleted: number;
  filesMoved: number;
  writeConflicts: number;
  transactionRollbacks: number;
  checkpointBytesCreated: number;
}

export interface AgentCommandStatistics {
  commandsDetected: number;
  commandsRun: number;
  commandsBlocked: number;
  commandsTimedOut: number;
  commandsAborted: number;
  commandOutputBytes: number;
  verificationRuns: number;
  verificationSteps: number;
  verificationFailures: number;
  regressionsDetected: number;
  preExistingIssuesDetected: number;
  repairAttempts: number;
}

export interface AgentVerificationSummary {
  verificationId: string;
  status: string;
  commandsRun: number;
  passedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  newErrors: number;
  preExistingErrors: number;
  durationMs: number;
}

export interface AgentRunResult {
  answer: string;
  steps: number;
  toolCalls: number;
  finishReason: AgentFinishReason;
  phase: AgentPhase;
  changeSummary?: AgentChangeSummary;
  verificationSummary?: AgentVerificationSummary;
  filesRead: number;
  linesRead: number;
  searchesPerformed: number;
  searchMatches: number;
  toolErrors: number;
  uniqueFilesAccessed: string[];
  durationMs: number;
  writeStatistics: AgentWriteStatistics;
  commandStatistics: AgentCommandStatistics;
}

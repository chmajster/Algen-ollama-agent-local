import type {
  IndependentReviewReport,
  SecurityReviewReport,
  SpecialistResult,
  SpecialistRole,
} from "@local-code-agent/agent-specialists";
import type { TaskGraphSnapshot } from "@local-code-agent/task-graph";

export type OrchestrationMode = "analysis" | "implementation" | "autonomous";
export type OrchestrationState =
  | "created"
  | "planning"
  | "awaiting_plan_approval"
  | "scheduled"
  | "running"
  | "replanning"
  | "merging_changes"
  | "verifying"
  | "reviewing"
  | "security_review"
  | "awaiting_final_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "security_stopped"
  | "recovery_required";

export interface OrchestrationBudget {
  maxAgents: number;
  maxParallelAgents: number;
  maxSubtasks: number;
  maxDepth: number;
  maxTotalSteps: number;
  maxTotalToolCalls: number;
  maxTotalCommands: number;
  maxTotalDurationMs: number;
  maxTotalContextTokens: number;
}

export interface OrchestrationUsage {
  agentsCreated: number;
  agentsCompleted: number;
  agentsFailed: number;
  maxParallelObserved: number;
  subtasksCreated: number;
  totalSteps: number;
  totalToolCalls: number;
  totalCommands: number;
  totalDurationMs: number;
  estimatedContextTokens: number;
  replans: number;
  retries: number;
}

export type OrchestrationArtifactType =
  | "repository_map"
  | "symbol_analysis"
  | "architecture_report"
  | "security_report"
  | "test_plan"
  | "implementation_plan"
  | "change_proposal"
  | "change_set_reference"
  | "verification_report"
  | "review_report"
  | "performance_report"
  | "documentation_plan"
  | "conflict_report"
  | "final_summary";

export interface SharedArtifact {
  id: string;
  sessionId: string;
  producerTaskId: string;
  producerRole: SpecialistRole;
  type: OrchestrationArtifactType;
  version: number;
  createdAt: string;
  contentHash: string;
  payload: unknown;
  confidence?: number;
  warnings: string[];
}

export interface AgentMessage {
  id: string;
  sessionId: string;
  fromTaskId: string;
  toTaskId: string;
  type:
    | "artifact_available"
    | "clarification_request"
    | "clarification_response"
    | "dependency_failed"
    | "conflict_detected"
    | "task_cancelled";
  payload: unknown;
  createdAt: string;
}

export interface AgentConflict {
  id: string;
  type:
    | "requirement_interpretation"
    | "architecture"
    | "implementation"
    | "test_expectation"
    | "security"
    | "file_edit"
    | "verification";
  agents: SpecialistRole[];
  summary: string;
  evidence: string[];
  resolution: "automatic" | "planner_revision" | "user_decision" | "unresolved";
  selectedOption?: string;
}

export interface OrchestrationPlanVersion {
  version: number;
  createdAt: string;
  reason: string;
  graph: TaskGraphSnapshot;
  approvedAt?: string;
}

export interface OrchestrationSessionManifest {
  id: string;
  taskSummary: string;
  mode: OrchestrationMode;
  state: OrchestrationState;
  createdAt: string;
  updatedAt: string;
  approvedPlanVersion?: number;
  finalApprovedAt?: string;
  planVersions: OrchestrationPlanVersion[];
  budget: OrchestrationBudget;
  usage: OrchestrationUsage;
  requestedSpecialists: SpecialistRole[];
  agents: Array<{
    id: string;
    taskId: string;
    role: SpecialistRole;
    model: string;
    status: "created" | "running" | "completed" | "failed";
    warning?: string;
  }>;
  results: Record<string, SpecialistResult>;
  artifactIds: string[];
  conflicts: AgentConflict[];
  warnings: string[];
  requiresManualResume: boolean;
}

export interface OrchestrationFinalReport {
  sessionId: string;
  status: "ready_for_approval" | "changes_required" | "security_blocked" | "failed";
  taskSummary: string;
  planExecution: Array<{
    nodeId: string;
    title: string;
    role: SpecialistRole;
    status: string;
    summary: string;
    artifacts: string[];
  }>;
  changes?: {
    changeSetId: string;
    filesModified: number;
    filesCreated: number;
    filesDeleted: number;
    additions: number;
    deletions: number;
  };
  verification?: {
    status: string;
    testsPassed?: number;
    testsFailed?: number;
    newDiagnostics: number;
  };
  architectureSummary?: string;
  securityReview?: SecurityReviewReport;
  independentReview?: IndependentReviewReport;
  conflicts: AgentConflict[];
  unresolvedIssues: string[];
  limitations: string[];
  recommendation: "apply" | "revise" | "manual_review" | "reject";
}

export interface OrchestrationAuditEntry {
  timestamp: string;
  sessionId: string;
  action:
    | "session_created"
    | "plan_created"
    | "plan_approved"
    | "node_started"
    | "node_completed"
    | "node_failed"
    | "agent_started"
    | "agent_completed"
    | "artifact_created"
    | "conflict_detected"
    | "replan"
    | "review_completed"
    | "security_block"
    | "result_approved"
    | "session_completed"
    | "session_cancelled"
    | "session_failed";
  nodeId?: string;
  role?: SpecialistRole;
  state: string;
  result?: string;
  errorCode?: string;
  durationMs?: number;
}

export interface OrchestrationStatistics {
  orchestrationSessionsCreated: number;
  orchestrationSessionsCompleted: number;
  orchestrationSessionsFailed: number;
  orchestrationSessionsCancelled: number;
  specialistAgentsCreated: number;
  specialistAgentsCompleted: number;
  specialistAgentsFailed: number;
  taskGraphNodesCreated: number;
  taskGraphNodesCompleted: number;
  taskGraphNodesFailed: number;
  maxParallelAgentsObserved: number;
  orchestrationReplans: number;
  orchestrationRetries: number;
  sharedArtifactsCreated: number;
  agentConflictsDetected: number;
  agentConflictsResolved: number;
  independentReviewsCompleted: number;
  securityReviewsCompleted: number;
  securityBlocks: number;
  orchestrationContextTokens: number;
  orchestrationToolCalls: number;
  orchestrationCommands: number;
}

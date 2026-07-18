export type GraphSpecialistRole =
  | "planner"
  | "repository_explorer"
  | "architecture"
  | "implementation"
  | "test"
  | "review"
  | "security"
  | "performance"
  | "documentation";

export type ArtifactType =
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

export interface ArtifactReference {
  id: string;
  type: ArtifactType;
  version?: number;
}

export interface SpecialistTaskBudget {
  maxSteps: number;
  maxToolCalls: number;
  maxCommands: number;
  maxContextTokens: number;
  maxDurationMs: number;
  maxRetries: number;
}

export interface SpecialistTaskUsage {
  steps: number;
  toolCalls: number;
  commands: number;
  contextTokens: number;
  durationMs: number;
  retries: number;
}

export type TaskNodeStatus =
  "pending" | "ready" | "running" | "blocked" | "completed" | "failed" | "cancelled" | "skipped";

export interface OrchestrationTaskNode {
  id: string;
  title: string;
  description: string;
  assignedRole: GraphSpecialistRole;
  dependencies: string[];
  status: TaskNodeStatus;
  accessMode: "read_only" | "prepare_changes" | "verification";
  expectedInputs: ArtifactReference[];
  expectedOutputs: ArtifactType[];
  files?: string[];
  risk: "low" | "medium" | "high" | "critical";
  verification?: string[];
  priority?: number;
  depth?: number;
  budget: SpecialistTaskBudget;
  usage: SpecialistTaskUsage;
}

export interface TaskGraphSnapshot {
  id: string;
  version: number;
  nodes: OrchestrationTaskNode[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskGraphValidationOptions {
  maxNodes: number;
  maxDepth: number;
}

export const DEFAULT_SPECIALIST_TASK_BUDGET: SpecialistTaskBudget = {
  maxSteps: 25,
  maxToolCalls: 50,
  maxCommands: 10,
  maxContextTokens: 24_000,
  maxDurationMs: 900_000,
  maxRetries: 2,
};

export const EMPTY_SPECIALIST_TASK_USAGE: SpecialistTaskUsage = {
  steps: 0,
  toolCalls: 0,
  commands: 0,
  contextTokens: 0,
  durationMs: 0,
  retries: 0,
};

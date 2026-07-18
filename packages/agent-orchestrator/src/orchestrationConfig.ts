import type { SpecialistRole } from "@local-code-agent/agent-specialists";

export interface OrchestrationConfig {
  enabled: boolean;
  maxAgents: number;
  maxParallelAgents: number;
  maxSubtasks: number;
  maxDepth: number;
  maxTotalSteps: number;
  maxTotalToolCalls: number;
  maxTotalCommands: number;
  maxTotalDurationMs: number;
  maxTotalContextTokens: number;
  maxAgentContextTokens: number;
  maxAgentOutputChars: number;
  requirePlanApproval: boolean;
  requireFinalApproval: boolean;
  requireReview: boolean;
  requireSecurityReview: boolean;
  allowParallelWrites: false;
  consensusThreshold: number;
  stopOnCriticalSecurity: boolean;
  maxReplans: number;
  maxTaskRetries: number;
  artifactMaxBytes: number;
  messageMaxBytes: number;
  fileLeaseTimeoutMs: number;
  modelDefault: string;
  roleModels: Record<SpecialistRole, string>;
}

export const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationConfig = {
  enabled: true,
  maxAgents: 8,
  maxParallelAgents: 3,
  maxSubtasks: 30,
  maxDepth: 2,
  maxTotalSteps: 200,
  maxTotalToolCalls: 400,
  maxTotalCommands: 100,
  maxTotalDurationMs: 7_200_000,
  maxTotalContextTokens: 200_000,
  maxAgentContextTokens: 24_000,
  maxAgentOutputChars: 50_000,
  requirePlanApproval: true,
  requireFinalApproval: true,
  requireReview: true,
  requireSecurityReview: true,
  allowParallelWrites: false,
  consensusThreshold: 0.67,
  stopOnCriticalSecurity: true,
  maxReplans: 3,
  maxTaskRetries: 2,
  artifactMaxBytes: 500_000,
  messageMaxBytes: 20_000,
  fileLeaseTimeoutMs: 300_000,
  modelDefault: "qwen3.5:9b",
  roleModels: {
    planner: "qwen3.5:9b",
    repository_explorer: "qwen2.5-coder:14b",
    architecture: "qwen3.5:9b",
    implementation: "qwen2.5-coder:14b",
    test: "qwen2.5-coder:14b",
    review: "qwen3.5:9b",
    security: "qwen3.5:9b",
    performance: "qwen3.5:9b",
    documentation: "qwen3.5:9b",
  },
};

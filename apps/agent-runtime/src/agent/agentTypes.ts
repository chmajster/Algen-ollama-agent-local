export type {
  AgentFinishReason,
  AgentRunOptions,
  AgentRunResult,
} from "@local-code-agent/shared-types";

import type { ChangeSessionSnapshot } from "@local-code-agent/change-engine";
import type { AgentCommandStatistics, AgentPhase } from "@local-code-agent/shared-types";

import type { VerificationSessionSnapshot } from "../verificationCoordinator.js";

export interface AgentLoopObserver {
  phaseChanged?(phase: AgentPhase): void;
  message?(content: string): void;
  toolCallStarted?(event: { id: string; name: string }): void;
  toolCallCompleted?(event: { id: string; name: string; durationMs: number }): void;
  toolCallFailed?(event: { id: string; name: string; durationMs: number; error: string }): void;
}

export interface AgentLoopConfiguration {
  defaultMaxSteps: number;
  maxToolResultChars?: number;
  debug?: boolean;
  logger?: (message: string) => void;
  changeSession?: () => ChangeSessionSnapshot;
  verificationSession?: () => VerificationSessionSnapshot;
  commandStatistics?: () => AgentCommandStatistics;
  observer?: AgentLoopObserver;
}

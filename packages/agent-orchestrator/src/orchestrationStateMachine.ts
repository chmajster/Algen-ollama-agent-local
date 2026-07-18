import { OrchestrationSessionStateError } from "./errors.js";
import type { OrchestrationState } from "./orchestrationTypes.js";

const TRANSITIONS: Record<OrchestrationState, readonly OrchestrationState[]> = {
  created: ["planning", "cancelled", "failed"],
  planning: ["awaiting_plan_approval", "scheduled", "failed", "cancelled"],
  awaiting_plan_approval: ["scheduled", "cancelled", "failed"],
  scheduled: ["running", "cancelled", "recovery_required"],
  running: [
    "replanning",
    "merging_changes",
    "verifying",
    "reviewing",
    "security_review",
    "awaiting_final_approval",
    "failed",
    "cancelled",
    "security_stopped",
    "recovery_required",
  ],
  replanning: ["awaiting_plan_approval", "scheduled", "failed", "cancelled"],
  merging_changes: ["verifying", "reviewing", "failed", "cancelled", "recovery_required"],
  verifying: [
    "reviewing",
    "security_review",
    "replanning",
    "failed",
    "cancelled",
    "recovery_required",
  ],
  reviewing: [
    "security_review",
    "replanning",
    "awaiting_final_approval",
    "failed",
    "cancelled",
    "recovery_required",
  ],
  security_review: [
    "awaiting_final_approval",
    "security_stopped",
    "replanning",
    "failed",
    "cancelled",
    "recovery_required",
  ],
  awaiting_final_approval: ["completed", "replanning", "cancelled", "failed"],
  completed: [],
  failed: ["recovery_required"],
  cancelled: [],
  security_stopped: ["replanning", "cancelled"],
  recovery_required: ["scheduled", "cancelled", "failed"],
};

export class OrchestrationStateMachine {
  public transition(current: OrchestrationState, next: OrchestrationState): OrchestrationState {
    if (!TRANSITIONS[current].includes(next)) {
      throw new OrchestrationSessionStateError(
        `Niedozwolone przejście orkiestracji ${current} → ${next}.`,
      );
    }
    return next;
  }
}

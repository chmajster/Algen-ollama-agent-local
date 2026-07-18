import { randomUUID } from "node:crypto";

import type { ProposedAction, SpecialistResult } from "@local-code-agent/agent-specialists";

import { AgentConflictUnresolvedError } from "./errors.js";
import type { AgentConflict } from "./orchestrationTypes.js";

function normalizedFiles(action: ProposedAction): string[] {
  return (action.files ?? []).map((path) => path.replaceAll("\\", "/").toLowerCase()).sort();
}

function overlap(left: ProposedAction, right: ProposedAction): string[] {
  const rightFiles = new Set(normalizedFiles(right));
  return normalizedFiles(left).filter((path) => rightFiles.has(path));
}

export class ConflictResolutionService {
  public detect(results: readonly SpecialistResult[]): AgentConflict[] {
    const conflicts: AgentConflict[] = [];
    for (let leftIndex = 0; leftIndex < results.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < results.length; rightIndex += 1) {
        const left = results[leftIndex];
        const right = results[rightIndex];
        if (left === undefined || right === undefined || left.role === right.role) continue;
        for (const leftAction of left.proposedActions) {
          for (const rightAction of right.proposedActions) {
            const files = overlap(leftAction, rightAction);
            if (files.length === 0 || leftAction.description === rightAction.description) continue;
            conflicts.push({
              id: randomUUID(),
              type:
                left.role === "security" || right.role === "security" ? "security" : "file_edit",
              agents: [left.role, right.role],
              summary: `Sprzeczne zalecenia dla: ${files.join(", ")}.`,
              evidence: [leftAction.description, rightAction.description],
              resolution: "unresolved",
            });
          }
        }
      }
    }
    return conflicts;
  }

  public resolve(
    conflict: AgentConflict,
    selectedOption: string,
    actor: "user" | "planner" | "automatic",
  ): AgentConflict {
    if (conflict.type === "security" && actor !== "user") {
      throw new AgentConflictUnresolvedError(
        "Konfliktu bezpieczeństwa nie może automatycznie rozstrzygnąć agent.",
      );
    }
    return {
      ...structuredClone(conflict),
      resolution:
        actor === "user" ? "user_decision" : actor === "planner" ? "planner_revision" : "automatic",
      selectedOption,
    };
  }

  public assertResolved(conflicts: readonly AgentConflict[]): void {
    if (conflicts.some((conflict) => conflict.resolution === "unresolved")) {
      throw new AgentConflictUnresolvedError();
    }
  }
}

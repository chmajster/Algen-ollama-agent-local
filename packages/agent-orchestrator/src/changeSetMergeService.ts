import { randomUUID } from "node:crypto";

import type { FileOperation, TextPatch } from "@local-code-agent/change-engine";

export interface ChangeSetMergeConflict {
  path: string;
  operationIds: string[];
  type:
    | "overlapping_edit"
    | "hash_mismatch"
    | "create_create"
    | "edit_delete"
    | "move_edit"
    | "unknown";
  message: string;
}

export interface ChangeSetMergeResult {
  mergeable: boolean;
  mergedChangeSetId?: string;
  mergedOperations?: FileOperation[];
  conflicts: ChangeSetMergeConflict[];
  warnings: string[];
}

function paths(operation: FileOperation): string[] {
  return operation.type === "move_file"
    ? [operation.sourcePath, operation.destinationPath]
    : [operation.path];
}

function lineRangesOverlap(left: TextPatch, right: TextPatch): boolean {
  for (const a of left.lineRangeReplacements ?? []) {
    for (const b of right.lineRangeReplacements ?? []) {
      if (a.startLine <= b.endLine && b.startLine <= a.endLine) return true;
    }
  }
  const oldTexts = new Set(left.replacements.map((replacement) => replacement.oldText));
  return right.replacements.some((replacement) => oldTexts.has(replacement.oldText));
}

export class ChangeSetMergeService {
  public merge(
    changeSets: ReadonlyArray<{ id: string; operations: FileOperation[] }>,
    limits: { maxOperations: number; maxFiles: number },
  ): ChangeSetMergeResult {
    const merged: FileOperation[] = [];
    const conflicts: ChangeSetMergeConflict[] = [];
    for (const changeSet of changeSets) {
      for (const operation of changeSet.operations) {
        const colliding = merged.filter((existing) =>
          paths(existing).some((left) => paths(operation).includes(left)),
        );
        if (colliding.length === 0) {
          merged.push(structuredClone(operation));
          continue;
        }
        const existing = colliding[0];
        if (existing === undefined) continue;
        const path =
          paths(operation).find((item) => paths(existing).includes(item)) ??
          paths(operation)[0] ??
          "unknown";
        if (existing.type === "apply_patch" && operation.type === "apply_patch") {
          if (existing.expectedHash !== operation.expectedHash) {
            conflicts.push(this.conflict(path, existing, operation, "hash_mismatch"));
          } else if (lineRangesOverlap(existing.patch, operation.patch)) {
            conflicts.push(this.conflict(path, existing, operation, "overlapping_edit"));
          } else {
            existing.patch.replacements.push(...structuredClone(operation.patch.replacements));
            existing.patch.lineRangeReplacements = [
              ...(existing.patch.lineRangeReplacements ?? []),
              ...(structuredClone(operation.patch.lineRangeReplacements) ?? []),
            ];
            existing.additions += operation.additions;
            existing.deletions += operation.deletions;
          }
        } else if (existing.type === "create_file" && operation.type === "create_file") {
          conflicts.push(this.conflict(path, existing, operation, "create_create"));
        } else if (
          (existing.type === "delete_file" && operation.type === "apply_patch") ||
          (existing.type === "apply_patch" && operation.type === "delete_file")
        ) {
          conflicts.push(this.conflict(path, existing, operation, "edit_delete"));
        } else if (existing.type === "move_file" || operation.type === "move_file") {
          conflicts.push(this.conflict(path, existing, operation, "move_edit"));
        } else {
          conflicts.push(this.conflict(path, existing, operation, "unknown"));
        }
      }
    }
    const files = new Set(merged.flatMap(paths));
    if (merged.length > limits.maxOperations || files.size > limits.maxFiles) {
      conflicts.push({
        path: "*",
        operationIds: merged.map((operation) => operation.id),
        type: "unknown",
        message: "Scalony ChangeSet przekracza centralny limit zmian.",
      });
    }
    return {
      mergeable: conflicts.length === 0,
      ...(conflicts.length === 0
        ? { mergedChangeSetId: randomUUID(), mergedOperations: merged }
        : {}),
      conflicts,
      warnings: [],
    };
  }

  private conflict(
    path: string,
    left: FileOperation,
    right: FileOperation,
    type: ChangeSetMergeConflict["type"],
  ): ChangeSetMergeConflict {
    return {
      path,
      operationIds: [left.id, right.id],
      type,
      message: `Operacje ${left.id} i ${right.id} są sprzeczne; żadna nie została wybrana jako ostatnia.`,
    };
  }
}

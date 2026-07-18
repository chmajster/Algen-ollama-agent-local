import { TaskGraphDeadlockError } from "./errors.js";
import type { OrchestrationTaskNode } from "./graphTypes.js";

function fileConflict(left: OrchestrationTaskNode, right: OrchestrationTaskNode): boolean {
  const paths = new Set((left.files ?? []).map((path) => path.replaceAll("\\", "/").toLowerCase()));
  return (right.files ?? []).some((path) => paths.has(path.replaceAll("\\", "/").toLowerCase()));
}

export class GraphScheduler {
  public selectBatch(
    ready: readonly OrchestrationTaskNode[],
    options: { maxParallel: number; allowParallelWrites: boolean },
  ): OrchestrationTaskNode[] {
    const sorted = [...ready].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id),
    );
    const selected: OrchestrationTaskNode[] = [];
    for (const node of sorted) {
      if (selected.length >= options.maxParallel) break;
      const writes = node.accessMode === "prepare_changes";
      if (
        writes &&
        !options.allowParallelWrites &&
        selected.some((item) => item.accessMode === "prepare_changes")
      )
        continue;
      if (
        selected.some(
          (item) => fileConflict(item, node) && (writes || item.accessMode === "prepare_changes"),
        )
      )
        continue;
      selected.push(node);
    }
    if (ready.length > 0 && selected.length === 0) throw new TaskGraphDeadlockError();
    return selected;
  }
}

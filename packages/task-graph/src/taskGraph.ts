import { randomUUID } from "node:crypto";

import { DependencyResolver } from "./dependencyResolver.js";
import { TaskGraphDependencyError, TaskGraphInvalidError } from "./errors.js";
import type { OrchestrationTaskNode, TaskGraphSnapshot, TaskNodeStatus } from "./graphTypes.js";
import { TaskGraphValidator } from "./taskGraphValidator.js";

function cloneNode(node: OrchestrationTaskNode): OrchestrationTaskNode {
  return structuredClone(node);
}

export class TaskGraph {
  private readonly nodes = new Map<string, OrchestrationTaskNode>();
  private version = 1;
  private readonly createdAt = new Date().toISOString();
  private updatedAt = this.createdAt;
  private readonly resolver = new DependencyResolver();

  public constructor(
    nodes: readonly OrchestrationTaskNode[],
    private readonly id: string = randomUUID(),
  ) {
    for (const node of nodes) this.nodes.set(node.id, cloneNode(node));
  }

  public validate(maxNodes = 30, maxDepth = 2): void {
    new TaskGraphValidator().validate(this.list(), { maxNodes, maxDepth });
  }

  public get(nodeId: string): OrchestrationTaskNode {
    const node = this.nodes.get(nodeId);
    if (node === undefined) throw new TaskGraphDependencyError(`Nie znaleziono węzła ${nodeId}.`);
    return cloneNode(node);
  }

  public list(): OrchestrationTaskNode[] {
    return [...this.nodes.values()].map(cloneNode);
  }

  public setStatus(nodeId: string, status: TaskNodeStatus): OrchestrationTaskNode {
    const node = this.nodes.get(nodeId);
    if (node === undefined) throw new TaskGraphDependencyError(`Nie znaleziono węzła ${nodeId}.`);
    const allowed: Record<TaskNodeStatus, TaskNodeStatus[]> = {
      pending: ["ready", "blocked", "cancelled", "skipped"],
      ready: ["running", "blocked", "cancelled"],
      running: ["completed", "failed", "blocked", "cancelled"],
      blocked: ["ready", "cancelled", "skipped"],
      completed: [],
      failed: ["ready", "cancelled"],
      cancelled: [],
      skipped: [],
    };
    if (!allowed[node.status].includes(status)) {
      throw new TaskGraphInvalidError(
        `Niedozwolone przejście ${node.status} → ${status} dla ${nodeId}.`,
      );
    }
    node.status = status;
    this.touch();
    return cloneNode(node);
  }

  public refreshReadiness(): void {
    const completed = new Set(
      this.list()
        .filter((node) => node.status === "completed" || node.status === "skipped")
        .map((node) => node.id),
    );
    const failed = new Set(
      this.list()
        .filter((node) => node.status === "failed" || node.status === "cancelled")
        .map((node) => node.id),
    );
    for (const node of this.nodes.values()) {
      if (node.status !== "pending" && node.status !== "blocked") continue;
      if (node.dependencies.some((dependency) => failed.has(dependency))) {
        node.status = "blocked";
      } else if (node.dependencies.every((dependency) => completed.has(dependency))) {
        node.status = "ready";
      }
    }
    this.touch();
  }

  public ready(): OrchestrationTaskNode[] {
    return this.list()
      .filter((node) => node.status === "ready")
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
  }

  public topologicalOrder(): string[] {
    return this.resolver.topologicalOrder(this.list());
  }

  public snapshot(): TaskGraphSnapshot {
    return {
      id: this.id,
      version: this.version,
      nodes: this.list(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  private touch(): void {
    this.version += 1;
    this.updatedAt = new Date().toISOString();
  }
}

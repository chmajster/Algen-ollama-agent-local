import {
  DEFAULT_SPECIALIST_TASK_BUDGET,
  EMPTY_SPECIALIST_TASK_USAGE,
  type GraphSpecialistRole,
  type OrchestrationTaskNode,
} from "./graphTypes.js";
import { TaskGraph } from "./taskGraph.js";

export interface TaskGraphNodeDraft {
  id: string;
  title: string;
  description: string;
  assignedRole: GraphSpecialistRole;
  dependencies?: string[];
  accessMode: OrchestrationTaskNode["accessMode"];
  expectedOutputs?: OrchestrationTaskNode["expectedOutputs"];
  files?: string[];
  risk?: OrchestrationTaskNode["risk"];
  verification?: string[];
  priority?: number;
}

export class TaskGraphBuilder {
  public build(
    drafts: readonly TaskGraphNodeDraft[],
    options: {
      requireReview: boolean;
      requireSecurityReview: boolean;
      maxNodes: number;
      maxDepth: number;
    },
  ): TaskGraph {
    const nodes: OrchestrationTaskNode[] = drafts.map((draft) => ({
      ...draft,
      dependencies: [...(draft.dependencies ?? [])],
      status: "pending",
      expectedInputs: [],
      expectedOutputs: [...(draft.expectedOutputs ?? [])],
      risk: draft.risk ?? "medium",
      depth: 1,
      budget: { ...DEFAULT_SPECIALIST_TASK_BUDGET },
      usage: { ...EMPTY_SPECIALIST_TASK_USAGE },
    }));
    const candidates = nodes.filter(
      (node) => node.assignedRole !== "security" && node.assignedRole !== "review",
    );
    const dependedOn = new Set(candidates.flatMap((node) => node.dependencies));
    const terminalInputs = candidates.filter((node) => !dependedOn.has(node.id));
    if (options.requireSecurityReview && !nodes.some((node) => node.assignedRole === "security")) {
      nodes.push(
        this.mandatoryNode(
          "security_review",
          "Independent security review",
          "security",
          terminalInputs.map((node) => node.id),
          "security_report",
        ),
      );
    }
    if (options.requireReview && !nodes.some((node) => node.assignedRole === "review")) {
      const dependencies = [
        ...terminalInputs.map((node) => node.id),
        ...nodes.filter((node) => node.assignedRole === "security").map((node) => node.id),
      ];
      nodes.push(
        this.mandatoryNode(
          "independent_review",
          "Independent change review",
          "review",
          [...new Set(dependencies)],
          "review_report",
        ),
      );
    }
    const graph = new TaskGraph(nodes);
    graph.validate(options.maxNodes, options.maxDepth);
    graph.refreshReadiness();
    return graph;
  }

  private mandatoryNode(
    id: string,
    title: string,
    assignedRole: GraphSpecialistRole,
    dependencies: string[],
    output: "security_report" | "review_report",
  ): OrchestrationTaskNode {
    return {
      id,
      title,
      description: title,
      assignedRole,
      dependencies,
      status: "pending",
      accessMode: "read_only",
      expectedInputs: [],
      expectedOutputs: [output],
      risk: "high",
      depth: 1,
      priority: 100,
      budget: { ...DEFAULT_SPECIALIST_TASK_BUDGET },
      usage: { ...EMPTY_SPECIALIST_TASK_USAGE },
    };
  }
}

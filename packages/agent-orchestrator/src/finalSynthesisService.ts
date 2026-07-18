import type {
  IndependentReviewReport,
  SecurityReviewReport,
  SpecialistResult,
} from "@local-code-agent/agent-specialists";
import type { TaskGraphSnapshot } from "@local-code-agent/task-graph";

import type {
  AgentConflict,
  OrchestrationFinalReport,
  SharedArtifact,
} from "./orchestrationTypes.js";

function payloadOf<T>(
  artifacts: readonly SharedArtifact[],
  type: SharedArtifact["type"],
): T | undefined {
  return artifacts.findLast((artifact) => artifact.type === type)?.payload as T | undefined;
}

export class FinalSynthesisService {
  public synthesize(input: {
    sessionId: string;
    taskSummary: string;
    graph: TaskGraphSnapshot;
    results: Record<string, SpecialistResult>;
    artifacts: SharedArtifact[];
    conflicts: AgentConflict[];
    consensus: "approved" | "changes_required" | "security_blocked";
    limitations?: string[];
  }): OrchestrationFinalReport {
    const securityReview = payloadOf<SecurityReviewReport>(input.artifacts, "security_report");
    const independentReview = payloadOf<IndependentReviewReport>(input.artifacts, "review_report");
    const architecture = payloadOf<{ summary?: string }>(input.artifacts, "architecture_report");
    const change = payloadOf<{ changeSetId?: string; files?: string[] }>(
      input.artifacts,
      "change_proposal",
    );
    const verification = payloadOf<{
      status?: string;
      testsPassed?: number;
      testsFailed?: number;
    }>(input.artifacts, "verification_report");
    const unresolvedIssues = input.conflicts
      .filter((conflict) => conflict.resolution === "unresolved")
      .map((conflict) => conflict.summary);
    if (independentReview?.verdict === "changes_required")
      unresolvedIssues.push("Niezależny review wymaga zmian.");
    if (securityReview?.verdict === "block")
      unresolvedIssues.push("Security review zablokował wynik.");
    const recommendation =
      input.consensus === "security_blocked"
        ? "reject"
        : unresolvedIssues.length > 0 || input.consensus === "changes_required"
          ? "revise"
          : independentReview?.verdict === "manual_review"
            ? "manual_review"
            : "apply";
    return {
      sessionId: input.sessionId,
      status:
        input.consensus === "security_blocked"
          ? "security_blocked"
          : recommendation === "apply"
            ? "ready_for_approval"
            : "changes_required",
      taskSummary: input.taskSummary,
      planExecution: input.graph.nodes.map((node) => {
        const result = input.results[node.id];
        return {
          nodeId: node.id,
          title: node.title,
          role: node.assignedRole,
          status: node.status,
          summary: result?.summary ?? "Brak wyniku specjalisty.",
          artifacts: input.artifacts
            .filter((artifact) => artifact.producerTaskId === node.id)
            .map((artifact) => artifact.id),
        };
      }),
      ...(change?.changeSetId === undefined
        ? {}
        : {
            changes: {
              changeSetId: change.changeSetId,
              filesModified: change.files?.length ?? 0,
              filesCreated: 0,
              filesDeleted: 0,
              additions: 0,
              deletions: 0,
            },
          }),
      ...(verification?.status === undefined
        ? {}
        : {
            verification: {
              status: verification.status,
              ...(verification.testsPassed === undefined
                ? {}
                : { testsPassed: verification.testsPassed }),
              ...(verification.testsFailed === undefined
                ? {}
                : { testsFailed: verification.testsFailed }),
              newDiagnostics: 0,
            },
          }),
      ...(architecture?.summary === undefined ? {} : { architectureSummary: architecture.summary }),
      ...(securityReview === undefined ? {} : { securityReview }),
      ...(independentReview === undefined ? {} : { independentReview }),
      conflicts: structuredClone(input.conflicts),
      unresolvedIssues,
      limitations: [
        ...new Set([
          ...(input.limitations ?? []),
          ...Object.values(input.results).flatMap((result) => result.limitations),
        ]),
      ],
      recommendation,
    };
  }
}

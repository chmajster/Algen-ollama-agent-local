import type { SpecialistResult, SpecialistRole } from "@local-code-agent/agent-specialists";

import {
  AgentConsensusError,
  IndependentReviewFailedError,
  IndependentReviewRequiredError,
  SecurityReviewBlockedError,
  SecurityReviewRequiredError,
} from "./errors.js";

const ROLE_WEIGHTS: Partial<Record<SpecialistRole, number>> = {
  implementation: 0.2,
  test: 0.2,
  review: 0.25,
  security: 0.25,
  architecture: 0.1,
};

export interface ConsensusDecision {
  outcome: "approved" | "changes_required" | "security_blocked";
  score: number;
  threshold: number;
  contributions: Array<{ role: SpecialistRole; weight: number; vote: number; reason: string }>;
}

function artifactVerdict(result: SpecialistResult, type: string): string | undefined {
  const artifact = result.artifacts.find((item) => item.type === type);
  if (typeof artifact?.payload !== "object" || artifact.payload === null) return undefined;
  const verdict = Reflect.get(artifact.payload, "verdict");
  return typeof verdict === "string" ? verdict : undefined;
}

export class ConsensusService {
  public evaluate(
    results: readonly SpecialistResult[],
    options: { threshold: number; requireReview: boolean; requireSecurityReview: boolean },
  ): ConsensusDecision {
    const latest = new Map<SpecialistRole, SpecialistResult>();
    for (const result of results) latest.set(result.role, result);
    const review = latest.get("review");
    const security = latest.get("security");
    if (options.requireReview && review === undefined) throw new IndependentReviewRequiredError();
    if (options.requireSecurityReview && security === undefined)
      throw new SecurityReviewRequiredError();

    const securityVerdict =
      security === undefined ? undefined : artifactVerdict(security, "security_report");
    if (security?.status === "security_stop" || securityVerdict === "block") {
      throw new SecurityReviewBlockedError();
    }
    const reviewVerdict =
      review === undefined ? undefined : artifactVerdict(review, "review_report");
    if (reviewVerdict === "changes_required") throw new IndependentReviewFailedError();

    const contributions: ConsensusDecision["contributions"] = [];
    for (const [role, weight] of Object.entries(ROLE_WEIGHTS) as Array<[SpecialistRole, number]>) {
      const result = latest.get(role);
      if (result === undefined) continue;
      const vote = result.status === "completed" && reviewVerdict !== "manual_review" ? 1 : 0;
      contributions.push({ role, weight, vote, reason: `${result.status}: ${result.summary}` });
    }
    const availableWeight = contributions.reduce((sum, item) => sum + item.weight, 0);
    if (availableWeight === 0)
      throw new AgentConsensusError("Brak wyników ról objętych konsensusem.");
    const score =
      contributions.reduce((sum, item) => sum + item.weight * item.vote, 0) / availableWeight;
    return {
      outcome: score >= options.threshold ? "approved" : "changes_required",
      score,
      threshold: options.threshold,
      contributions,
    };
  }
}

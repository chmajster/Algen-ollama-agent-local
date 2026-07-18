import { z } from "zod";

import type { SpecialistResult, SpecialistRole } from "@local-code-agent/agent-specialists";

import { SpecialistResultInvalidError } from "./errors.js";

const evidenceSchema = z
  .object({
    type: z.enum(["file", "symbol", "diagnostic", "command", "verification", "commit"]),
    reference: z.string().min(1).max(2_000),
  })
  .strict();

const proposedActionSchema = z
  .object({
    type: z.enum([
      "read_context",
      "prepare_change",
      "run_verification",
      "request_replan",
      "request_user_decision",
      "no_action",
    ]),
    description: z.string().min(1).max(5_000),
    files: z.array(z.string().min(1).max(1_000)).max(500).optional(),
    changeSetReference: z.string().min(1).max(200).optional(),
  })
  .strict();

const resultSchema = z
  .object({
    taskId: z.string().min(1).max(200),
    role: z.enum([
      "planner",
      "repository_explorer",
      "architecture",
      "implementation",
      "test",
      "review",
      "security",
      "performance",
      "documentation",
    ]),
    status: z.enum(["completed", "failed", "blocked", "needs_clarification", "security_stop"]),
    summary: z.string().min(1).max(50_000),
    artifacts: z
      .array(
        z
          .object({
            type: z.string().min(1).max(100),
            payload: z.unknown(),
            confidence: z.number().min(0).max(1).optional(),
            warnings: z.array(z.string().max(2_000)).max(100),
          })
          .strict(),
      )
      .max(50),
    evidence: z.array(evidenceSchema).max(200),
    proposedActions: z.array(proposedActionSchema).max(100),
    confidence: z.enum(["high", "medium", "low"]),
    limitations: z.array(z.string().max(2_000)).max(100),
    warnings: z.array(z.string().max(2_000)).max(100),
    usage: z
      .object({
        steps: z.number().int().nonnegative(),
        toolCalls: z.number().int().nonnegative(),
        commands: z.number().int().nonnegative(),
        contextTokens: z.number().int().nonnegative(),
        durationMs: z.number().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

export class AgentResultValidator {
  public validate(value: unknown, taskId: string, role: SpecialistRole): SpecialistResult {
    const parsed = resultSchema.safeParse(value);
    if (!parsed.success) {
      throw new SpecialistResultInvalidError("Wynik specjalisty nie spełnia schematu.", {
        cause: parsed.error,
      });
    }
    if (parsed.data.taskId !== taskId || parsed.data.role !== role) {
      throw new SpecialistResultInvalidError("Wynik należy do innego zadania lub roli.");
    }
    if (parsed.data.status === "completed" && parsed.data.evidence.length === 0) {
      throw new SpecialistResultInvalidError("Ukończony wynik musi zawierać dowody.");
    }
    if (role === "implementation" && parsed.data.status === "completed") {
      const proposal = parsed.data.artifacts.find(
        (artifact) => artifact.type === "change_proposal",
      );
      const changeSetId =
        typeof proposal?.payload === "object" && proposal.payload !== null
          ? Reflect.get(proposal.payload, "changeSetId")
          : undefined;
      if (
        typeof changeSetId !== "string" ||
        !parsed.data.proposedActions.some(
          (action) => action.type === "prepare_change" && action.changeSetReference === changeSetId,
        )
      ) {
        throw new SpecialistResultInvalidError(
          "Implementacja musi wskazać rzeczywisty ChangeSet w artefakcie i proponowanej akcji.",
        );
      }
    }
    return parsed.data as SpecialistResult;
  }
}

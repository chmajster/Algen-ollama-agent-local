import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { TaskGraphSnapshot } from "@local-code-agent/task-graph";

import { OrchestrationManifestError, OrchestrationRecoveryError } from "./errors.js";
import { OrchestrationSession } from "./orchestrationSession.js";
import type {
  OrchestrationFinalReport,
  OrchestrationSessionManifest,
} from "./orchestrationTypes.js";

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

const manifestSchema = z
  .object({
    id: z.string().uuid(),
    taskSummary: z.string().min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    mode: z.enum(["analysis", "implementation", "autonomous"]),
    state: z.enum([
      "created",
      "planning",
      "awaiting_plan_approval",
      "scheduled",
      "running",
      "replanning",
      "merging_changes",
      "verifying",
      "reviewing",
      "security_review",
      "awaiting_final_approval",
      "completed",
      "failed",
      "cancelled",
      "security_stopped",
      "recovery_required",
    ]),
    planVersions: z
      .array(
        z
          .object({
            version: z.number().int().positive(),
            createdAt: z.string(),
            reason: z.string(),
            graph: z.unknown(),
            approvedAt: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
    budget: z
      .object({
        maxAgents: z.number().int().positive(),
        maxParallelAgents: z.number().int().positive(),
        maxSubtasks: z.number().int().positive(),
        maxDepth: z.number().int().positive(),
        maxTotalSteps: z.number().int().positive(),
        maxTotalToolCalls: z.number().int().positive(),
        maxTotalCommands: z.number().int().nonnegative(),
        maxTotalDurationMs: z.number().positive(),
        maxTotalContextTokens: z.number().int().positive(),
      })
      .strict(),
    usage: z
      .object({
        agentsCreated: z.number().int().nonnegative(),
        agentsCompleted: z.number().int().nonnegative(),
        agentsFailed: z.number().int().nonnegative(),
        maxParallelObserved: z.number().int().nonnegative(),
        subtasksCreated: z.number().int().nonnegative(),
        totalSteps: z.number().int().nonnegative(),
        totalToolCalls: z.number().int().nonnegative(),
        totalCommands: z.number().int().nonnegative(),
        totalDurationMs: z.number().nonnegative(),
        estimatedContextTokens: z.number().int().nonnegative(),
        replans: z.number().int().nonnegative(),
        retries: z.number().int().nonnegative(),
      })
      .strict(),
    requestedSpecialists: z.array(z.string()),
    agents: z.array(z.unknown()),
    results: z.record(z.string(), z.unknown()),
    artifactIds: z.array(z.string().uuid()),
    conflicts: z.array(z.unknown()),
    warnings: z.array(z.string()),
    requiresManualResume: z.boolean(),
  })
  .passthrough();

const artifactTypeSchema = z.enum([
  "repository_map",
  "symbol_analysis",
  "architecture_report",
  "security_report",
  "test_plan",
  "implementation_plan",
  "change_proposal",
  "change_set_reference",
  "verification_report",
  "review_report",
  "performance_report",
  "documentation_plan",
  "conflict_report",
  "final_summary",
]);

const finalReportSchema = z
  .object({
    sessionId: z.string().uuid(),
    status: z.enum(["ready_for_approval", "changes_required", "security_blocked", "failed"]),
    taskSummary: z.string(),
    planExecution: z.array(z.unknown()),
    conflicts: z.array(z.unknown()),
    unresolvedIssues: z.array(z.string()),
    limitations: z.array(z.string()),
    recommendation: z.enum(["apply", "revise", "manual_review", "reject"]),
  })
  .passthrough();

const graphSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    nodes: z.array(
      z
        .object({
          id: z.string().min(2),
          title: z.string(),
          description: z.string(),
          assignedRole: z.enum([
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
          dependencies: z.array(z.string()),
          status: z.enum([
            "pending",
            "ready",
            "running",
            "blocked",
            "completed",
            "failed",
            "cancelled",
            "skipped",
          ]),
          accessMode: z.enum(["read_only", "prepare_changes", "verification"]),
          expectedInputs: z.array(
            z
              .object({
                id: z.string(),
                type: artifactTypeSchema,
                version: z.number().int().positive().optional(),
              })
              .strict(),
          ),
          expectedOutputs: z.array(artifactTypeSchema),
          risk: z.enum(["low", "medium", "high", "critical"]),
          budget: z
            .object({
              maxSteps: z.number().int().positive(),
              maxToolCalls: z.number().int().positive(),
              maxCommands: z.number().int().nonnegative(),
              maxContextTokens: z.number().int().positive(),
              maxDurationMs: z.number().positive(),
              maxRetries: z.number().int().nonnegative(),
            })
            .strict(),
          usage: z
            .object({
              steps: z.number().int().nonnegative(),
              toolCalls: z.number().int().nonnegative(),
              commands: z.number().int().nonnegative(),
              contextTokens: z.number().int().nonnegative(),
              durationMs: z.number().nonnegative(),
              retries: z.number().int().nonnegative(),
            })
            .strict(),
        })
        .passthrough(),
    ),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export class OrchestrationRecovery {
  public constructor(private readonly rootDirectory: string) {}

  public sessionDirectory(sessionId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(sessionId))
      throw new OrchestrationManifestError("Niepoprawny identyfikator sesji.");
    return join(this.rootDirectory, sessionId);
  }

  public async persist(session: OrchestrationSession): Promise<void> {
    const directory = this.sessionDirectory(session.id());
    await mkdir(directory, { recursive: true });
    await atomicJson(join(directory, "manifest.json"), session.manifest());
    await atomicJson(join(directory, "task-graph.json"), session.taskGraph().snapshot());
    await appendFile(
      join(directory, "journal.jsonl"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), sessionId: session.id(), state: session.state(), graphVersion: session.taskGraph().snapshot().version })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  public async persistReport(sessionId: string, report: OrchestrationFinalReport): Promise<void> {
    const directory = this.sessionDirectory(sessionId);
    await mkdir(directory, { recursive: true });
    await atomicJson(join(directory, "final-report.json"), report);
  }

  public async loadReport(sessionId: string): Promise<OrchestrationFinalReport | undefined> {
    try {
      const parsed = finalReportSchema.safeParse(
        JSON.parse(
          await readFile(join(this.sessionDirectory(sessionId), "final-report.json"), "utf8"),
        ),
      );
      if (!parsed.success || parsed.data.sessionId !== sessionId)
        throw new OrchestrationManifestError("Niepoprawny raport końcowy.");
      return parsed.data as OrchestrationFinalReport;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return undefined;
      throw new OrchestrationRecoveryError(`Nie można odczytać raportu sesji ${sessionId}.`, {
        cause: error,
      });
    }
  }

  public async load(sessionId: string): Promise<OrchestrationSession> {
    try {
      const directory = this.sessionDirectory(sessionId);
      const [manifestText, graphText] = await Promise.all([
        readFile(join(directory, "manifest.json"), "utf8"),
        readFile(join(directory, "task-graph.json"), "utf8"),
      ]);
      const manifestResult = manifestSchema.safeParse(JSON.parse(manifestText));
      const graphResult = graphSchema.safeParse(JSON.parse(graphText));
      if (!manifestResult.success || !graphResult.success) throw new OrchestrationManifestError();
      const manifest = manifestResult.data as unknown as OrchestrationSessionManifest;
      const graph = graphResult.data as unknown as TaskGraphSnapshot;
      if (manifest.id !== sessionId) throw new OrchestrationManifestError();
      const session = OrchestrationSession.rehydrate(manifest, graph);
      session.taskGraph().validate(manifest.budget.maxSubtasks, manifest.budget.maxDepth);
      for (const node of session.taskGraph().list()) {
        if (node.status === "running") session.taskGraph().setStatus(node.id, "blocked");
      }
      if (
        [
          "scheduled",
          "running",
          "merging_changes",
          "verifying",
          "reviewing",
          "security_review",
        ].includes(session.state())
      ) {
        session.requireManualResume();
      }
      return session;
    } catch (error) {
      if (error instanceof OrchestrationManifestError) throw error;
      throw new OrchestrationRecoveryError(`Nie można odtworzyć sesji ${sessionId}.`, {
        cause: error,
      });
    }
  }
}

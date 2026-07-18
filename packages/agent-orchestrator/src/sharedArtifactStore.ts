import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { SpecialistRole } from "@local-code-agent/agent-specialists";

import {
  ArtifactNotFoundError,
  ArtifactSchemaError,
  ArtifactSizeLimitError,
  ArtifactVersionError,
} from "./errors.js";
import type { OrchestrationArtifactType, SharedArtifact } from "./orchestrationTypes.js";

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(100_000),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema).max(1_000),
    z.record(z.string().max(200), jsonValueSchema),
  ]),
);

const findingSchema = z
  .object({
    id: z.string().min(1),
    severity: z.string().min(1),
    message: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1),
  })
  .passthrough();

const SCHEMAS: Record<OrchestrationArtifactType, z.ZodType> = {
  repository_map: z.object({ files: z.array(z.string()), summary: z.string() }).passthrough(),
  symbol_analysis: z.object({ symbols: z.array(z.unknown()), summary: z.string() }).passthrough(),
  architecture_report: z
    .object({ summary: z.string(), evidence: z.array(z.string()).min(1) })
    .passthrough(),
  security_report: z
    .object({
      verdict: z.enum(["pass", "warning", "block"]),
      findings: z.array(findingSchema),
      reviewedAreas: z.array(z.string()),
      limitations: z.array(z.string()),
    })
    .passthrough(),
  test_plan: z
    .object({ scenarios: z.array(z.unknown()), requirements: z.array(z.string()) })
    .passthrough(),
  implementation_plan: z.object({ steps: z.array(z.unknown()).min(1) }).passthrough(),
  change_proposal: z
    .object({ changeSetId: z.string().min(1), files: z.array(z.string()) })
    .passthrough(),
  change_set_reference: z.object({ changeSetId: z.string().min(1) }).passthrough(),
  verification_report: z
    .object({ status: z.string().min(1), evidence: z.array(z.string()).min(1) })
    .passthrough(),
  review_report: z
    .object({
      verdict: z.enum(["approve", "changes_required", "manual_review"]),
      findings: z.array(findingSchema),
      planCoverage: z.array(z.unknown()),
      limitations: z.array(z.string()),
    })
    .passthrough(),
  performance_report: z
    .object({ summary: z.string(), evidence: z.array(z.string()).min(1) })
    .passthrough(),
  documentation_plan: z
    .object({ files: z.array(z.string()), changes: z.array(z.string()) })
    .passthrough(),
  conflict_report: z.object({ conflicts: z.array(z.unknown()).min(1) }).passthrough(),
  final_summary: z.object({ status: z.string(), summary: z.string() }).passthrough(),
};

const FORBIDDEN_KEYS = new Set([
  "chainofthought",
  "chain_of_thought",
  "reasoning",
  "messages",
  "history",
  "systemprompt",
  "system_prompt",
  "token",
  "password",
  "secret",
  "authorization",
]);

function assertNoPrivateHistory(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrivateHistory(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.replaceAll("-", "").toLowerCase())) {
      throw new ArtifactSchemaError(`Artefakt zawiera zabronione pole ${key}.`);
    }
    assertNoPrivateHistory(nested);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function artifactContentHash(payload: unknown): string {
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

export class SharedArtifactStore {
  private readonly artifacts = new Map<string, SharedArtifact>();

  public constructor(
    private readonly maxBytes: number,
    private readonly directory?: string,
  ) {}

  public async create(input: {
    sessionId: string;
    producerTaskId: string;
    producerRole: SpecialistRole;
    type: OrchestrationArtifactType;
    payload: unknown;
    confidence?: number;
    warnings?: string[];
  }): Promise<SharedArtifact> {
    assertNoPrivateHistory(input.payload);
    const json = JSON.stringify(input.payload);
    if (Buffer.byteLength(json, "utf8") > this.maxBytes) throw new ArtifactSizeLimitError();
    const generic = jsonValueSchema.safeParse(input.payload);
    const typed = SCHEMAS[input.type].safeParse(input.payload);
    if (!generic.success || !typed.success) {
      throw new ArtifactSchemaError(`Payload ${input.type} nie spełnia schematu.`, {
        cause: typed.success ? generic.error : typed.error,
      });
    }
    const previous = [...this.artifacts.values()]
      .filter(
        (artifact) =>
          artifact.sessionId === input.sessionId &&
          artifact.producerTaskId === input.producerTaskId &&
          artifact.type === input.type,
      )
      .sort((a, b) => b.version - a.version)[0];
    const artifact: SharedArtifact = {
      id: randomUUID(),
      sessionId: input.sessionId,
      producerTaskId: input.producerTaskId,
      producerRole: input.producerRole,
      type: input.type,
      version: (previous?.version ?? 0) + 1,
      createdAt: new Date().toISOString(),
      contentHash: artifactContentHash(input.payload),
      payload: structuredClone(input.payload),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      warnings: [...(input.warnings ?? [])],
    };
    this.artifacts.set(artifact.id, artifact);
    if (this.directory !== undefined) {
      const artifactDirectory = join(this.directory, input.sessionId, "artifacts");
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        join(artifactDirectory, `${artifact.id}.json`),
        `${JSON.stringify(artifact, null, 2)}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
    }
    return structuredClone(artifact);
  }

  public get(id: string, version?: number): SharedArtifact {
    const artifact = this.artifacts.get(id);
    if (artifact === undefined) throw new ArtifactNotFoundError(`Nie znaleziono artefaktu ${id}.`);
    if (version !== undefined && artifact.version !== version) throw new ArtifactVersionError();
    return structuredClone(artifact);
  }

  public list(sessionId: string, type?: OrchestrationArtifactType): SharedArtifact[] {
    return [...this.artifacts.values()]
      .filter(
        (artifact) =>
          artifact.sessionId === sessionId && (type === undefined || artifact.type === type),
      )
      .map((artifact) => structuredClone(artifact));
  }

  public async load(path: string): Promise<SharedArtifact> {
    const artifact = JSON.parse(await readFile(path, "utf8")) as SharedArtifact;
    if (artifact.contentHash !== artifactContentHash(artifact.payload)) {
      throw new ArtifactSchemaError("Hash artefaktu nie zgadza się z payloadem.");
    }
    assertNoPrivateHistory(artifact.payload);
    if (!SCHEMAS[artifact.type]?.safeParse(artifact.payload).success) {
      throw new ArtifactSchemaError();
    }
    this.artifacts.set(artifact.id, structuredClone(artifact));
    return structuredClone(artifact);
  }

  public clearPayloadCache(sessionId: string): void {
    if (this.directory === undefined) return;
    for (const [id, artifact] of this.artifacts) {
      if (artifact.sessionId === sessionId) this.artifacts.delete(id);
    }
  }
}

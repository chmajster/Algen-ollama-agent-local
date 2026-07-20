import type { TaskHistoryItem } from "../history/historyService.js";
import type { AgentViewState } from "./messages.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, 4_000) : fallback;
}

export function mapHistory(items: TaskHistoryItem[]): AgentViewState["history"] {
  return items.map((item) => ({
    id: item.id,
    title: item.promptSummary,
    mode: item.mode,
    status: item.status,
    createdAt: item.createdAt,
    filesChanged: item.filesChanged,
    ...(item.verificationStatus === undefined
      ? {}
      : { verificationStatus: item.verificationStatus }),
  }));
}

export function mapChanges(value: unknown): AgentViewState["changes"] {
  const changes = record(value);
  const operations = Array.isArray(changes?.operations) ? changes.operations : [];
  return operations.flatMap((raw, index) => {
    const item = record(raw);
    if (item === undefined) return [];
    const rawType = text(item.type, "modify_file");
    const operation = rawType.includes("create")
      ? "create"
      : rawType.includes("delete")
        ? "delete"
        : rawType.includes("move") || rawType.includes("rename")
          ? "move"
          : "modify";
    return [{
      id: text(item.id, `change-${index}`),
      path: text(item.path ?? item.destinationPath ?? item.sourcePath, "nieznany plik"),
      operation,
      ...(typeof item.reason === "string" ? { reason: text(item.reason) } : {}),
    }];
  });
}

export function mapCheckpoints(value: unknown): AgentViewState["checkpoints"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = record(raw);
    if (item === undefined || typeof item.id !== "string") return [];
    return [{
      id: text(item.id),
      task: text(item.task, `Checkpoint ${item.id.slice(0, 8)}`),
      ...(typeof item.createdAt === "string" ? { createdAt: text(item.createdAt) } : {}),
    }];
  });
}

function verificationKind(name: string): "test" | "lint" | "typecheck" | "build" | "other" {
  const normalized = name.toLowerCase();
  if (normalized.includes("test")) return "test";
  if (normalized.includes("lint")) return "lint";
  if (normalized.includes("type")) return "typecheck";
  if (normalized.includes("build")) return "build";
  return "other";
}

export function mapVerification(value: unknown): AgentViewState["verification"] {
  const report = record(value);
  if (report === undefined) return null;
  const steps = (Array.isArray(report.steps) ? report.steps : []).flatMap((raw, index) => {
    const item = record(raw);
    if (item === undefined) return [];
    const name = text(item.displayName ?? item.commandId, "Krok");
    const details = [item.error, item.stderr, item.stdout]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join("\n")
      .slice(0, 100_000);
    return [{
      id: text(item.commandId, `step-${index}`),
      name,
      kind: verificationKind(name),
      status: text(item.status, "unknown"),
      ...(details === "" ? {} : { details }),
      ...(typeof item.durationMs === "number" && item.durationMs >= 0
        ? { durationMs: item.durationMs }
        : {}),
    }];
  });
  return {
    status: steps.length === 0 ? "not-run" : text(report.status, "unknown"),
    ...(typeof report.durationMs === "number" && report.durationMs >= 0
      ? { durationMs: report.durationMs }
      : {}),
    passed: steps.filter((step) => step.status === "passed").length,
    failed: steps.filter((step) => step.status === "failed").length,
    steps,
  };
}

export function mapOrchestration(value: unknown): AgentViewState["orchestration"] {
  const data = record(value);
  const session = record(data?.session);
  if (session === undefined) return null;
  const graph = record(data?.graph);
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const review = record(data?.review);
  const status = text(session.state, "unknown");
  const mapItems = (items: unknown[], titleKey: string) => items.flatMap((raw, index) => {
    const item = record(raw);
    if (item === undefined) return [];
    return [{
      id: text(item.id, `item-${index}`),
      title: text(item[titleKey] ?? item.id, "Element"),
      status: text(item.status, "pending"),
    }];
  });
  return {
    sessionId: text(session.id),
    status,
    mode: text(session.mode, "unknown"),
    stage: text(session.stage ?? session.currentStage, status),
    requiresAction: status === "awaiting_plan_approval" || status === "awaiting_final_approval",
    securityBlocked: status === "security_stopped" || review?.status === "security_blocked",
    agents: mapItems(agents, "role"),
    tasks: mapItems(nodes, "title"),
    ...(review === undefined ? {} : { reviewStatus: text(review.status, "pending") }),
  };
}

export function mapGitHub(value: unknown, enabled = true): AgentViewState["github"] {
  const status = record(value);
  const user = record(status?.user);
  const repository = record(status?.repository);
  const permissions = record(status?.permissions);
  const pullRequest = record(status?.pullRequest ?? status?.currentPullRequest);
  const rateLimit = record(status?.rateLimit);
  return {
    enabled: status?.enabled === false ? false : enabled,
    connected: user !== undefined,
    ...(typeof user?.login === "string" ? { account: text(user.login) } : {}),
    ...(typeof repository?.owner === "string"
      ? { repository: `${text(repository.owner)}/${text(repository.repository ?? repository.name)}` }
      : {}),
    permission: permissions?.write === true ? "write" : permissions?.read === true ? "read" : "unknown",
    ...(pullRequest === undefined
      ? {}
      : { pullRequest: text(pullRequest.title ?? pullRequest.url ?? pullRequest.number) }),
    ...(typeof status?.checksStatus === "string" ? { checksStatus: text(status.checksStatus) } : {}),
    ...(typeof rateLimit?.remaining === "number"
      ? { apiLimit: `${rateLimit.remaining}/${String(rateLimit.limit ?? "?")}` }
      : {}),
    ...(typeof status?.error === "string" ? { error: text(status.error) } : {}),
  };
}

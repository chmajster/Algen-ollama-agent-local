import type {
  AgentMessage,
  AgentModelClient,
  AgentRunOptions,
  AgentRunResult,
  AgentPhase,
  ModelToolCall,
} from "@local-code-agent/shared-types";

import { AgentMaxStepsError, RepeatedToolCallError } from "../errors.js";
import type { ToolRegistry } from "../tools/toolRegistry.js";
import type { AgentLoopConfiguration } from "./agentTypes.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

interface RunMetrics {
  filesRead: number;
  linesRead: number;
  searchesPerformed: number;
  searchMatches: number;
  toolErrors: number;
  uniqueFilesAccessed: Set<string>;
}

type ResultBase = Pick<AgentRunResult, "answer" | "steps" | "toolCalls" | "finishReason">;

const EMPTY_WRITE_STATISTICS = {
  patchesPrepared: 0,
  patchesApplied: 0,
  filesCreated: 0,
  filesDeleted: 0,
  filesMoved: 0,
  writeConflicts: 0,
  transactionRollbacks: 0,
  checkpointBytesCreated: 0,
} as const;

const EMPTY_COMMAND_STATISTICS = {
  commandsDetected: 0,
  commandsRun: 0,
  commandsBlocked: 0,
  commandsTimedOut: 0,
  commandsAborted: 0,
  commandOutputBytes: 0,
  verificationRuns: 0,
  verificationSteps: 0,
  verificationFailures: 0,
  regressionsDetected: 0,
  preExistingIssuesDetected: 0,
  repairAttempts: 0,
} as const;

function phaseForTool(toolName: string, current: AgentPhase): AgentPhase {
  if (toolName === "detect_project_commands") return "planning";
  if (["prepare_patch", "create_file", "delete_file", "move_file"].includes(toolName)) {
    return "editing";
  }
  if (toolName === "preview_changes" || toolName === "get_file_diff") return "preview";
  if (toolName === "apply_changes" || toolName === "restore_checkpoint") return "confirmation";
  if (
    [
      "run_project_command",
      "run_tests",
      "run_linter",
      "run_typecheck",
      "run_build",
      "run_formatter",
      "run_verification",
    ].includes(toolName)
  ) {
    return "verification";
  }
  return current;
}

const TRUNCATION_MESSAGE =
  "Wynik narzędzia został skrócony przez runtime. Użyj bardziej precyzyjnych argumentów lub odczytaj mniejszy zakres.";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function callFingerprint(call: ModelToolCall): string {
  try {
    return `${call.function.name}:${JSON.stringify(canonicalize(call.function.arguments))}`;
  } catch {
    return `${call.function.name}:${String(call.function.arguments)}`;
  }
}

function changedWorkspace(toolName: string, value: unknown): boolean {
  if (toolName === "restore_checkpoint") return true;
  return toolName === "apply_changes" && isRecord(value) && value.status === "applied";
}

function shortenText(value: string, targetLength: number): string {
  if (value.length <= targetLength) return value;
  const marker = "\n… [skrócono przez runtime] …\n";
  const available = Math.max(targetLength - marker.length, 20);
  const beginning = Math.ceil(available / 2);
  return value.slice(0, beginning) + marker + value.slice(-(available - beginning));
}

function serializeSuccessfulToolResult(value: unknown, maxChars: number): string {
  let candidate: unknown = isRecord(value) ? { ...value } : value;
  if (isRecord(candidate)) {
    const preTruncated = Object.values(candidate).some(
      (item) => typeof item === "string" && item.length > Math.floor(maxChars / 2),
    );
    candidate = Object.fromEntries(
      Object.entries(candidate).map(([key, item]) => [
        key,
        typeof item === "string" && item.length > Math.floor(maxChars / 2)
          ? shortenText(item, Math.floor(maxChars / 2))
          : item,
      ]),
    );
    if (preTruncated && isRecord(candidate)) {
      candidate = {
        ...candidate,
        truncated: true,
        runtimeTruncated: true,
        truncationMessage: TRUNCATION_MESSAGE,
      };
    }
  }

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const envelope = { ok: true, result: candidate };
    const serialized = JSON.stringify(envelope);
    if (serialized.length <= maxChars) return serialized;

    if (!isRecord(candidate)) break;
    const strings = Object.entries(candidate)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort((left, right) => right[1].length - left[1].length);
    const arrays = Object.entries(candidate)
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .sort((left, right) => right[1].length - left[1].length);

    const longestString = strings[0];
    const longestArray = arrays[0];
    if (longestString !== undefined && longestString[1].length > 80) {
      candidate = {
        ...candidate,
        [longestString[0]]: shortenText(longestString[1], Math.ceil(longestString[1].length / 2)),
        truncated: true,
        runtimeTruncated: true,
        truncationMessage: TRUNCATION_MESSAGE,
      };
      continue;
    }
    if (longestArray !== undefined && longestArray[1].length > 1) {
      candidate = {
        ...candidate,
        [longestArray[0]]: longestArray[1].slice(0, Math.ceil(longestArray[1].length / 2)),
        truncated: true,
        runtimeTruncated: true,
        truncationMessage: TRUNCATION_MESSAGE,
      };
      continue;
    }
    break;
  }

  return JSON.stringify({
    ok: true,
    result: {
      truncated: true,
      runtimeTruncated: true,
      truncationMessage: TRUNCATION_MESSAGE,
    },
  });
}

function serializeToolError(error: unknown): string {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "TOOL_ERROR";
  const recoverable =
    isRecord(error) && typeof error.recoverable === "boolean" ? error.recoverable : true;
  return JSON.stringify({
    ok: false,
    error: {
      code,
      type: error instanceof Error ? error.name : "ToolError",
      message: errorMessage(error),
      recoverable,
      ...(isRecord(error) && typeof error.path === "string" ? { path: error.path } : {}),
      ...(isRecord(error) && isRecord(error.details) ? { details: error.details } : {}),
    },
  });
}

function sanitizeArguments(value: unknown, key = ""): unknown {
  if (/token|password|secret|credential|content|query/iu.test(key)) return "[pominięto]";
  if (Array.isArray(value)) return value.map((item) => sanitizeArguments(item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [
        childKey,
        sanitizeArguments(item, childKey),
      ]),
    );
  }
  return value;
}

function debugArguments(value: unknown): string {
  try {
    return shortenText(JSON.stringify(sanitizeArguments(value)), 1_000);
  } catch {
    return "[argumenty niemożliwe do serializacji]";
  }
}

function trimHistory(history: AgentMessage[], maxChars: number): void {
  let total = history.reduce((sum, message) => sum + message.content.length, 0);
  while (history.length > 4 && total > maxChars) {
    const removed = history.splice(2, 1)[0];
    if (removed !== undefined) total -= removed.content.length;
  }
}

function recordToolSuccess(toolName: string, value: unknown, metrics: RunMetrics): void {
  if (!isRecord(value)) return;
  if (toolName === "read_file" || toolName === "read_file_range") {
    if (value.binary === true || typeof value.path !== "string") return;
    metrics.filesRead += 1;
    metrics.uniqueFilesAccessed.add(value.path);
    if (typeof value.startLine === "number" && typeof value.endLine === "number") {
      metrics.linesRead += Math.max(0, value.endLine - value.startLine + 1);
    }
  }
  if (toolName === "search_text" && Array.isArray(value.matches)) {
    metrics.searchMatches += value.matches.length;
  }
}

export class AgentLoop {
  private readonly logger: (message: string) => void;

  public constructor(
    private readonly client: AgentModelClient,
    private readonly tools: ToolRegistry,
    private readonly configuration: AgentLoopConfiguration,
  ) {
    this.logger = configuration.logger ?? console.error;
  }

  private debug(message: string): void {
    if (this.configuration.debug === true) this.logger(`[agent] ${message}`);
  }

  private toolDebug(message: string): void {
    if (this.configuration.debug === true) this.logger(`[tool] ${message}`);
  }

  public async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const startedAt = performance.now();
    const metrics: RunMetrics = {
      filesRead: 0,
      linesRead: 0,
      searchesPerformed: 0,
      searchMatches: 0,
      toolErrors: 0,
      uniqueFilesAccessed: new Set(),
    };
    let phase: AgentPhase = "analysis";
    this.configuration.observer?.phaseChanged?.(phase);
    const setPhase = (next: AgentPhase): void => {
      if (phase === next) return;
      phase = next;
      this.configuration.observer?.phaseChanged?.(next);
    };
    let commandLimitReached = false;
    const finish = (result: ResultBase): AgentRunResult => {
      const session = this.configuration.changeSession?.();
      const verification = this.configuration.verificationSession?.();
      let finishReason = result.finishReason;
      if (finishReason === "completed" && session !== undefined) {
        if (session.status === "applied") finishReason = "changes_applied";
        else if (session.status === "pending_confirmation") {
          finishReason = "changes_pending_confirmation";
        } else if (session.status === "rejected") finishReason = "changes_rejected";
        else if (session.mode === "preview" && session.previewAvailable) {
          finishReason = "preview_completed";
        }
      }
      if (finishReason === "preview_completed" && commandLimitReached) {
        finishReason = "command_limit_reached";
      }
      if (finishReason === "completed" || finishReason === "changes_applied") {
        if (verification?.rolledBack === true) finishReason = "rolled_back";
        else if (verification?.maxRepairAttemptsReached === true)
          finishReason = "max_repair_attempts";
        else if (commandLimitReached) finishReason = "command_limit_reached";
        else if (verification?.report?.status === "passed") finishReason = "verification_passed";
        else if (verification?.report?.status === "failed") finishReason = "verification_failed";
        else if (
          verification?.report?.status === "unavailable" ||
          verification?.report?.status === "partial"
        ) {
          finishReason = "verification_unavailable";
        }
      }
      const finalPhase: AgentPhase =
        finishReason === "rolled_back"
          ? "rolled_back"
          : finishReason === "verification_failed" || finishReason === "max_repair_attempts"
            ? "failed"
            : finishReason === "verification_passed" || finishReason === "verification_unavailable"
              ? "completed"
              : session?.status === "pending_confirmation"
                ? "confirmation"
                : session?.status === "previewed"
                  ? "preview"
                  : finishReason === "changes_applied" || finishReason === "completed"
                    ? "completed"
                    : phase;
      this.configuration.observer?.phaseChanged?.(finalPhase);
      return {
        ...result,
        finishReason,
        phase: finalPhase,
        ...(session === undefined ||
        session.totals.filesChanged +
          session.totals.filesCreated +
          session.totals.filesDeleted +
          session.totals.filesMoved ===
          0
          ? {}
          : {
              changeSummary: {
                changeSetId: session.changeSetId,
                mode: session.mode,
                ...session.totals,
                ...(session.checkpointId === undefined
                  ? {}
                  : { checkpointId: session.checkpointId }),
              },
            }),
        ...(verification?.report === undefined
          ? {}
          : {
              verificationSummary: {
                verificationId: verification.report.id,
                status: verification.report.status,
                commandsRun: verification.report.steps.length,
                passedSteps: verification.report.summary.passed,
                failedSteps: verification.report.summary.failed,
                skippedSteps:
                  verification.report.summary.skipped + verification.report.summary.unavailable,
                newErrors: verification.report.regressions.length,
                preExistingErrors: verification.report.preExistingIssues.length,
                durationMs: verification.report.durationMs,
              },
            }),
        filesRead: metrics.filesRead,
        linesRead: metrics.linesRead,
        searchesPerformed: metrics.searchesPerformed,
        searchMatches: metrics.searchMatches,
        toolErrors: metrics.toolErrors,
        uniqueFilesAccessed: [...metrics.uniqueFilesAccessed].sort((left, right) =>
          left.localeCompare(right),
        ),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        writeStatistics: session?.statistics ?? { ...EMPTY_WRITE_STATISTICS },
        commandStatistics: this.configuration.commandStatistics?.() ?? {
          ...EMPTY_COMMAND_STATISTICS,
        },
      };
    };

    const maxSteps = Math.min(
      options.maxSteps ?? this.configuration.defaultMaxSteps,
      this.configuration.maxModelCalls ?? Number.POSITIVE_INFINITY,
    );
    const maxToolResultChars = this.configuration.maxToolResultChars ?? 50_000;
    const task = options.task.trim();
    if (task === "") {
      return finish({
        answer: "Zadanie nie może być puste.",
        steps: 0,
        toolCalls: 0,
        finishReason: "error",
      });
    }

    const history: AgentMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: task },
    ];
    const executedCalls = new Set<string>();
    let workspaceVersion = 0;
    let toolCalls = 0;

    for (let step = 1; step <= maxSteps; step += 1) {
      if (
        this.configuration.maxTaskDurationMs !== undefined &&
        performance.now() - startedAt >= this.configuration.maxTaskDurationMs
      ) {
        return finish({
          answer: "Zadanie przekroczyĹ‚o skonfigurowany limit czasu.",
          steps: step - 1,
          toolCalls,
          finishReason: "error",
        });
      }
      if (
        this.configuration.maxFilesPerTask !== undefined &&
        metrics.uniqueFilesAccessed.size >= this.configuration.maxFilesPerTask
      ) {
        return finish({
          answer: "OsiÄ…gniÄ™to limit plikĂłw odczytanych w tym zadaniu.",
          steps: step - 1,
          toolCalls,
          finishReason: "error",
        });
      }
      if (isSignalAborted(options.signal)) {
        this.debug(`przerwano przed krokiem ${step}`);
        return finish({
          answer: "Działanie agenta zostało przerwane.",
          steps: step - 1,
          toolCalls,
          finishReason: "aborted",
        });
      }

      this.debug(`krok ${step}/${maxSteps}`);
      try {
        trimHistory(history, this.configuration.maxContextChars ?? 32_768);
        const response = await this.client.chat({
          messages: history,
          tools: this.tools.getDefinitions(),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const assistantMessage: AgentMessage = { ...response.message, role: "assistant" };
        history.push(assistantMessage);

        const requestedCalls = assistantMessage.toolCalls ?? [];
        if (requestedCalls.length === 0) {
          this.configuration.observer?.message?.(assistantMessage.content);
          this.debug(`zakończono po ${step} krokach`);
          return finish({
            answer:
              assistantMessage.content.trim() === ""
                ? "Model zakończył pracę bez treści odpowiedzi."
                : assistantMessage.content,
            steps: step,
            toolCalls,
            finishReason: "completed",
          });
        }

        toolCalls += requestedCalls.length;
        for (const [callIndex, call] of requestedCalls.entries()) {
          const fingerprint = `${workspaceVersion}:${callFingerprint(call)}`;
          if (executedCalls.has(fingerprint)) {
            const error = new RepeatedToolCallError(call.function.name);
            this.debug(error.message);
            return finish({
              answer: error.message,
              steps: step,
              toolCalls,
              finishReason: "error",
            });
          }
          executedCalls.add(fingerprint);
          setPhase(phaseForTool(call.function.name, phase));
          const toolStartedAt = performance.now();
          const toolCallId = call.id ?? `${step}-${callIndex + 1}-${call.function.name}`;
          this.configuration.observer?.toolCallStarted?.({
            id: toolCallId,
            name: call.function.name,
          });
          this.toolDebug(call.function.name);
          this.toolDebug(`argumenty: ${debugArguments(call.function.arguments)}`);
          if (call.function.name === "search_text") metrics.searchesPerformed += 1;
          let content: string;
          try {
            const value = await this.tools.execute(call.function.name, call.function.arguments);
            if (call.function.name === "apply_changes") {
              const status = isRecord(value) ? value.status : undefined;
              const verification =
                isRecord(value) && isRecord(value.verification) ? value.verification : undefined;
              setPhase(
                verification?.status === "failed"
                  ? "repair"
                  : verification === undefined && status === "applied"
                    ? "applying"
                    : verification === undefined
                      ? "confirmation"
                      : "verification",
              );
            }
            recordToolSuccess(call.function.name, value, metrics);
            if (changedWorkspace(call.function.name, value)) workspaceVersion += 1;
            content = serializeSuccessfulToolResult(value, maxToolResultChars);
            this.configuration.observer?.toolCallCompleted?.({
              id: toolCallId,
              name: call.function.name,
              durationMs: Math.max(0, Math.round(performance.now() - toolStartedAt)),
            });
          } catch (error: unknown) {
            metrics.toolErrors += 1;
            if (isRecord(error) && error.code === "COMMAND_LIMIT_EXCEEDED") {
              commandLimitReached = true;
            }
            this.debug(errorMessage(error));
            content = serializeToolError(error);
            this.configuration.observer?.toolCallFailed?.({
              id: toolCallId,
              name: call.function.name,
              durationMs: Math.max(0, Math.round(performance.now() - toolStartedAt)),
              error: errorMessage(error),
            });
          }
          this.toolDebug(`zakończono w ${Math.round(performance.now() - toolStartedAt)} ms`);
          this.toolDebug(`wynik: ${Buffer.byteLength(content, "utf8")} bajty`);
          history.push({ role: "tool", toolName: call.function.name, content });
        }
      } catch (error: unknown) {
        if (isSignalAborted(options.signal) || isAbortError(error)) {
          this.debug(`przerwano podczas kroku ${step}`);
          return finish({
            answer: "Działanie agenta zostało przerwane.",
            steps: step - 1,
            toolCalls,
            finishReason: "aborted",
          });
        }
        this.debug(`błąd modelu: ${errorMessage(error)}`);
        return finish({
          answer: errorMessage(error),
          steps: step,
          toolCalls,
          finishReason: "error",
        });
      }
    }

    const error = new AgentMaxStepsError(maxSteps);
    this.debug(error.message);
    return finish({
      answer: error.message,
      steps: maxSteps,
      toolCalls,
      finishReason: "max_steps",
    });
  }
}

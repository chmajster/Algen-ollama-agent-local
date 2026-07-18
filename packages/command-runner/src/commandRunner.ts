import type {
  CommandHistoryEntry,
  CommandPolicyContext,
  CommandResult,
  CommandRunnerOptions,
  CommandRunnerStatistics,
  CommandSpec,
} from "./commandTypes.js";
import { CommandHistoryService } from "./commandHistoryService.js";
import { DefaultCommandPolicy } from "./commandPolicy.js";
import { CommandValidator } from "./commandValidator.js";
import { EnvironmentSanitizer } from "./environmentSanitizer.js";
import {
  CommandConfirmationRequiredError,
  CommandExecutionDisabledError,
  CommandLimitExceededError,
  CommandPolicyViolationError,
} from "./errors.js";
import { ExecutableResolver } from "./executableResolver.js";
import { ProcessRunner } from "./processRunner.js";

export type CommandConfirmationDecision = "approved" | "rejected" | "pending";
export type CommandConfirmationProvider = (
  command: CommandSpec,
) => Promise<CommandConfirmationDecision>;
export interface CommandRunnerObserver {
  beforeRun?(command: CommandSpec): void;
  afterRun?(result: CommandResult): void;
}

export interface CommandRunContext extends Omit<
  CommandPolicyContext,
  "workspaceRoot" | "commandsExecuted"
> {
  reason?: string;
}

export class CommandRunner {
  private readonly resolver: ExecutableResolver;
  private readonly validator: CommandValidator;
  private readonly policy: DefaultCommandPolicy;
  private readonly environment: EnvironmentSanitizer;
  private readonly processRunner: ProcessRunner;
  private readonly history: CommandHistoryService;
  private commandsAccepted = 0;
  private readonly statistics: CommandRunnerStatistics = {
    commandsRun: 0,
    commandsBlocked: 0,
    commandsTimedOut: 0,
    commandsAborted: 0,
    commandOutputBytes: 0,
  };

  public constructor(
    private readonly options: CommandRunnerOptions,
    private readonly confirmationProvider?: CommandConfirmationProvider,
    private readonly observer: CommandRunnerObserver = {},
  ) {
    this.resolver = new ExecutableResolver({ workspaceRoot: options.workspaceRoot });
    this.validator = new CommandValidator(options.workspaceRoot, this.resolver);
    this.policy = new DefaultCommandPolicy(options.policy);
    this.environment = new EnvironmentSanitizer({
      allowedVariables: options.allowedEnvVars,
      allowOverrides: options.allowEnvOverrides,
    });
    this.processRunner = new ProcessRunner({
      outputLimits: options.outputLimits,
      maxParallelCommands: options.maxParallelCommands,
    });
    this.history = new CommandHistoryService(options.workspaceRoot);
  }

  public async run(
    requested: CommandSpec,
    context: CommandRunContext,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    if (!this.options.policy.enabled) throw new CommandExecutionDisabledError();
    const command = await this.validator.validate(requested);
    const policyContext: CommandPolicyContext = {
      accessMode: context.accessMode,
      workspaceRoot: this.options.workspaceRoot,
      commandsExecuted: this.commandsAccepted,
    };
    const decision = this.policy.evaluate(command, policyContext);
    const baseHistory: CommandHistoryEntry = {
      timestamp: new Date().toISOString(),
      sessionId: this.options.sessionId,
      commandId: command.id,
      category: command.category,
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      policy: this.options.policy.policy,
      decision: decision.allowed ? "allowed" : "blocked",
      ...(context.reason === undefined ? {} : { reason: context.reason }),
    };
    if (!decision.allowed) {
      this.statistics.commandsBlocked += 1;
      await this.history.append({ ...baseHistory, reason: decision.reasons.join(" ") });
      if (this.commandsAccepted >= this.options.policy.maxCommandsPerSession) {
        throw new CommandLimitExceededError(undefined, {
          limit: this.options.policy.maxCommandsPerSession,
        });
      }
      throw new CommandPolicyViolationError(undefined, { reasons: decision.reasons });
    }
    if (decision.requiresConfirmation) {
      const confirmation = await this.confirmationProvider?.(command);
      if (confirmation !== "approved") {
        this.statistics.commandsBlocked += 1;
        await this.history.append({
          ...baseHistory,
          decision: "blocked",
          reason:
            confirmation === "rejected"
              ? "Użytkownik odrzucił polecenie."
              : "Polecenie oczekuje na potwierdzenie.",
        });
        throw new CommandConfirmationRequiredError();
      }
    }
    if (this.commandsAccepted >= this.options.policy.maxCommandsPerSession) {
      this.statistics.commandsBlocked += 1;
      await this.history.append({
        ...baseHistory,
        decision: "blocked",
        reason: "Przekroczono limit poleceń sesji.",
      });
      throw new CommandLimitExceededError(undefined, {
        limit: this.options.policy.maxCommandsPerSession,
      });
    }
    this.commandsAccepted += 1;
    const environment = this.environment.sanitize(process.env, command.environment);
    this.observer.beforeRun?.(command);
    const result = await this.processRunner.run(command, environment, signal);
    this.observer.afterRun?.(result);
    this.statistics.commandsRun += 1;
    this.statistics.commandOutputBytes += result.outputBytes;
    if (result.status === "timeout") this.statistics.commandsTimedOut += 1;
    if (result.status === "aborted") this.statistics.commandsAborted += 1;
    await this.history.append({
      ...baseHistory,
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputTruncated: result.outputTruncated,
    });
    return { ...result, policyDecision: decision };
  }

  public getStatistics(): CommandRunnerStatistics {
    return { ...this.statistics };
  }

  public getHistory(filter: Parameters<CommandHistoryService["list"]>[0] = {}) {
    return this.history.list(filter);
  }

  public getResolver(): ExecutableResolver {
    return this.resolver;
  }
}

import { spawn } from "node:child_process";
import { basename, join } from "node:path";

import type { CommandResult, CommandSpec, OutputLimits } from "./commandTypes.js";
import { CommandLimitExceededError, UnsafeShellExpressionError } from "./errors.js";
import { OutputLimiter } from "./outputLimiter.js";
import { ProcessTreeKiller } from "./processTreeKiller.js";

export interface ProcessRunnerOptions {
  outputLimits: OutputLimits;
  maxParallelCommands: number;
  treeKiller?: ProcessTreeKiller;
}

const SAFE_WINDOWS_WRAPPERS = new Set([
  "npm.cmd",
  "npx.cmd",
  "pnpm.cmd",
  "yarn.cmd",
  "bun.cmd",
  "mvnw.cmd",
  "gradlew.cmd",
  "composer.cmd",
  "pytest.cmd",
  "ruff.cmd",
  "mypy.cmd",
]);
const SAFE_BATCH_ARGUMENT = /^[\p{L}\p{N}_@./:\\=+,-]+$/u;

function processInvocation(command: CommandSpec): {
  executable: string;
  args: string[];
  windowsVerbatimArguments: boolean;
} {
  if (process.platform !== "win32" || !command.executable.toLowerCase().endsWith(".cmd")) {
    return { executable: command.executable, args: command.args, windowsVerbatimArguments: false };
  }
  if (
    !SAFE_WINDOWS_WRAPPERS.has(basename(command.executable).toLowerCase()) ||
    /[\r\n"%!]/u.test(command.executable) ||
    command.args.some((argument) => !SAFE_BATCH_ARGUMENT.test(argument))
  ) {
    throw new UnsafeShellExpressionError(
      "Wrapper .cmd albo jego argumenty nie spełniają ograniczeń bezpiecznego adaptera.",
    );
  }
  const comspec =
    process.env.ComSpec ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  const commandLine = [
    `"${command.executable}"`,
    ...command.args.map((argument) => `"${argument}"`),
  ].join(" ");
  return {
    executable: comspec,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

export class ProcessRunner {
  private active = 0;
  private readonly treeKiller: ProcessTreeKiller;

  public constructor(private readonly options: ProcessRunnerOptions) {
    this.treeKiller = options.treeKiller ?? new ProcessTreeKiller();
  }

  public async run(
    command: CommandSpec,
    environment: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    if (this.active >= this.options.maxParallelCommands)
      throw new CommandLimitExceededError("Przekroczono limit równoległych poleceń.");
    this.active += 1;
    const startedAt = new Date();
    const stdout = new OutputLimiter(this.options.outputLimits);
    const stderr = new OutputLimiter(this.options.outputLimits);
    try {
      return await new Promise<CommandResult>((resolvePromise) => {
        let desiredStatus: CommandResult["status"] | undefined;
        let settled = false;
        const invocation = processInvocation(command);
        const child = spawn(invocation.executable, invocation.args, {
          cwd: command.cwd,
          env: environment,
          shell: false,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
        child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

        const finish = (
          status: CommandResult["status"],
          exitCode: number | null,
          signalName: string | null,
        ): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          const finishedAt = new Date();
          const stdoutResult = stdout.result();
          const stderrResult = stderr.result();
          resolvePromise({
            id: command.id,
            command: {
              executable: command.executable,
              args: [...command.args],
              cwd: command.cwd,
              category: command.category,
            },
            status,
            exitCode,
            signal: signalName,
            stdout: stdoutResult.text,
            stderr: stderrResult.text,
            outputTruncated: stdoutResult.truncated || stderrResult.truncated,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
            outputBytes: stdoutResult.bytes + stderrResult.bytes,
          });
        };
        const stop = (status: "timeout" | "aborted"): void => {
          if (desiredStatus !== undefined || settled) return;
          desiredStatus = status;
          void this.treeKiller.terminate(child).catch(() => undefined);
        };
        const abort = (): void => stop("aborted");
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted === true) abort();
        const timer = setTimeout(() => stop("timeout"), command.timeoutMs);
        child.once("error", (error) => {
          stderr.append(error.message);
          finish("spawn_error", null, null);
        });
        child.once("close", (code, signalName) => {
          const status = desiredStatus ?? (code === 0 ? "success" : "failed");
          finish(status, code, signalName);
        });
      });
    } finally {
      this.active -= 1;
    }
  }
}

import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import {
  LocalChangeService,
  type AccessMode,
  type ChangePreview,
  type ConfirmationProvider,
} from "@local-code-agent/change-engine";
import {
  CommandRunner,
  PackageManagerDetector,
  ShellDetector,
  type CommandConfirmationProvider,
  type CommandResult,
  type CommandRunnerObserver,
  type CommandSpec,
} from "@local-code-agent/command-runner";
import {
  ProjectVerifier,
  verificationReport,
  type VerificationScope,
} from "@local-code-agent/project-verifier";
import { LocalWorkspaceService } from "@local-code-agent/workspace";
import type { WorkspaceService } from "@local-code-agent/workspace";

import { AgentLoop } from "./agent/agentLoop.js";
import { isDebugRequested, loadConfig, type AgentConfig } from "./config.js";
import { ConfigurationError } from "./errors.js";
import { OllamaClient } from "./ollamaClient.js";
import { OrchestrationRuntimeService } from "./orchestration/orchestrationRuntimeService.js";
import { registerChangeTools } from "./tools/changeTools.js";
import { registerCommandTools } from "./tools/commandTools.js";
import { getCurrentTimeTool } from "./tools/getCurrentTime.js";
import { getPlatformInfoTool } from "./tools/getPlatformInfo.js";
import { ToolRegistry } from "./tools/toolRegistry.js";
import { registerWorkspaceTools } from "./tools/workspaceTools.js";
import { VerificationCoordinator } from "./verificationCoordinator.js";
import { RemoteRuntimeService } from "./remote/remoteRuntimeService.js";

interface ParsedCliArguments {
  task: string;
  doctor: boolean;
  workspace?: string;
  debug?: boolean;
  mode?: AccessMode;
  orchestrationMode?: "analysis" | "implementation" | "autonomous";
  verificationEnabled?: boolean;
  baselineEnabled?: boolean;
  verificationScope?: VerificationScope;
  yes: boolean;
  positionals: string[];
  githubRead: boolean;
  orchestrationTest: boolean;
}

function accessMode(value: string | undefined): AccessMode | undefined {
  if (value === undefined) return undefined;
  if (value === "readonly" || value === "preview" || value === "write") return value;
  throw new ConfigurationError("Opcja --mode przyjmuje: readonly, preview albo write.");
}

function orchestrationMode(
  value: string | undefined,
): "analysis" | "implementation" | "autonomous" | undefined {
  if (value === undefined) return undefined;
  if (value === "analysis" || value === "implementation" || value === "autonomous") return value;
  throw new ConfigurationError(
    "Opcja --mode dla orchestrate przyjmuje: analysis, implementation albo autonomous.",
  );
}

function verificationScope(value: string | undefined): VerificationScope | undefined {
  if (value === undefined) return undefined;
  if (["changed_files", "affected_packages", "workspace"].includes(value)) {
    return value as VerificationScope;
  }
  throw new ConfigurationError(
    "Opcja --verification-scope przyjmuje: changed_files, affected_packages albo workspace.",
  );
}

function parseCliArguments(args: readonly string[]): ParsedCliArguments {
  try {
    if (args.some((argument) => argument === "--token" || argument.startsWith("--token="))) {
      throw new ConfigurationError(
        "Token GitHub nie może być argumentem CLI. Użyj GITHUB_TOKEN, GH_TOKEN albo bezpiecznego magazynu.",
      );
    }
    const parsed = parseArgs({
      args: [...args],
      options: {
        workspace: { type: "string" },
        debug: { type: "boolean" },
        mode: { type: "string" },
        yes: { type: "boolean", default: false },
        verify: { type: "boolean" },
        baseline: { type: "boolean" },
        "verification-scope": { type: "string" },
        "github-read": { type: "boolean", default: false },
        "orchestration-test": { type: "boolean", default: false },
      },
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    });
    const orchestrationCommand = parsed.positionals[0] === "orchestrate";
    const mode = orchestrationCommand ? undefined : accessMode(parsed.values.mode);
    const orchestratedMode = orchestrationCommand
      ? orchestrationMode(parsed.values.mode)
      : undefined;
    const remoteWrite =
      parsed.positionals[0] === "task" &&
      (["publish", "push"].includes(parsed.positionals[1] ?? "") ||
        (parsed.positionals[1] === "pr" &&
          ["create", "reply", "resolve"].includes(parsed.positionals[2] ?? "")));
    if (parsed.values.yes && orchestrationCommand) {
      throw new ConfigurationError("Flaga --yes nie omija bramek zatwierdzenia orkiestracji.");
    }
    if (parsed.values.yes && mode !== "write" && !remoteWrite) {
      throw new ConfigurationError("Flaga --yes wymaga jawnej komendy zapisu albo --mode write.");
    }
    const doctor = parsed.positionals[0] === "doctor";
    const scope = verificationScope(parsed.values["verification-scope"]);
    return {
      task: doctor
        ? parsed.positionals.slice(1).join(" ").trim()
        : parsed.positionals.join(" ").trim(),
      doctor,
      ...(parsed.values.workspace === undefined ? {} : { workspace: parsed.values.workspace }),
      ...(parsed.values.debug === undefined ? {} : { debug: parsed.values.debug }),
      ...(mode === undefined ? {} : { mode }),
      ...(orchestratedMode === undefined ? {} : { orchestrationMode: orchestratedMode }),
      ...(parsed.values.verify === undefined ? {} : { verificationEnabled: parsed.values.verify }),
      ...(parsed.values.baseline === undefined ? {} : { baselineEnabled: parsed.values.baseline }),
      ...(scope === undefined ? {} : { verificationScope: scope }),
      yes: parsed.values.yes,
      positionals: parsed.positionals,
      githubRead: parsed.values["github-read"],
      orchestrationTest: parsed.values["orchestration-test"],
    };
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(
      `Nieprawidłowe argumenty CLI: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function promptForTask(signal: AbortSignal): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return await readline.question("Wpisz zadanie dla agenta: ", { signal });
  } finally {
    readline.close();
  }
}

async function askText(question: string, signal: AbortSignal): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return (await readline.question(question, { signal })).trim();
  } finally {
    readline.close();
  }
}

function displayChangePreview(preview: ChangePreview): void {
  console.log("\nProponowane zmiany:");
  console.log(`- zmodyfikowane pliki: ${preview.totals.filesChanged}`);
  console.log(`- nowe pliki: ${preview.totals.filesCreated}`);
  console.log(`- usunięte pliki: ${preview.totals.filesDeleted}`);
  console.log(`- przeniesione pliki: ${preview.totals.filesMoved}`);
  console.log(`- dodane linie: ${preview.totals.additions}`);
  console.log(`- usunięte linie: ${preview.totals.deletions}`);
  if (preview.diff !== "") console.log(`\n${preview.diff}`);
  for (const warning of preview.warnings) console.log(`Ostrzeżenie: ${warning}`);
}

async function askConfirmation(question: string, signal: AbortSignal): Promise<boolean> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(question, { signal });
    return ["y", "yes", "t", "tak"].includes(answer.trim().toLowerCase());
  } finally {
    readline.close();
  }
}

function createChangeConfirmation(options: {
  interactive: boolean;
  assumeYes: boolean;
  signal: AbortSignal;
}): ConfirmationProvider {
  return async (context) => {
    if (options.assumeYes) return "approved";
    if (!options.interactive) return "pending";
    if (context.preview !== undefined) displayChangePreview(context.preview);
    if (context.kind === "restore") {
      console.log(`\nCheckpoint: ${context.checkpointId ?? "nieznany"}`);
      console.log(`Powód: ${context.reason ?? "nie podano"}`);
    }
    return (await askConfirmation("Zastosować powyższe zmiany? [t/N] ", options.signal))
      ? "approved"
      : "rejected";
  };
}

function createCommandConfirmation(options: {
  interactive: boolean;
  assumeYes: boolean;
  signal: AbortSignal;
}): CommandConfirmationProvider {
  return async (command) => {
    if (options.assumeYes) return "approved";
    if (!options.interactive) return "pending";
    console.log("\nPolecenie wymaga potwierdzenia:");
    console.log(`Program: ${command.executable}`);
    console.log(`Argumenty: ${command.args.join(" ")}`);
    console.log(`Katalog: ${command.cwd}`);
    return (await askConfirmation("Uruchomić polecenie? [t/N] ", options.signal))
      ? "approved"
      : "rejected";
  };
}

function commandObserver() {
  return {
    beforeRun(command: CommandSpec): void {
      console.log(`\n[verification] ${command.displayName ?? command.id}`);
      console.log(`Program: ${command.executable}`);
      console.log(`Argumenty: ${command.args.join(" ") || "(brak)"}`);
      console.log(`Katalog: ${command.cwd}`);
      console.log(`Timeout: ${Math.round(command.timeoutMs / 1_000)} s`);
    },
    afterRun(result: CommandResult): void {
      console.log(`Wynik: ${result.status}`);
      console.log(`Kod wyjścia: ${result.exitCode ?? "brak"}`);
      console.log(`Czas: ${(result.durationMs / 1_000).toLocaleString("pl-PL")} s`);
    },
  };
}

export function createCommandRunner(
  config: AgentConfig,
  sessionId: string,
  confirmation: CommandConfirmationProvider,
  observer: CommandRunnerObserver = commandObserver(),
): CommandRunner {
  return new CommandRunner(
    {
      workspaceRoot: config.workspace,
      sessionId,
      policy: {
        enabled: config.commandExecutionEnabled,
        policy: config.commandPolicy,
        allowNetwork: config.allowNetwork,
        allowPackageInstall: config.allowPackageInstall,
        allowPackageScripts: config.allowPackageScripts,
        allowCustomCommands: config.allowCustomCommands,
        allowFormatCommands: config.allowFormatCommands,
        maxCommandsPerSession: config.maxCommandsPerSession,
      },
      outputLimits: {
        maxChars: config.maxCommandOutputChars,
        maxLines: config.maxCommandOutputLines,
        maxBytes: config.maxCommandOutputBytes,
      },
      maxParallelCommands: config.maxParallelCommands,
      allowEnvOverrides: config.allowEnvOverrides,
      allowedEnvVars: config.allowedEnvVars,
    },
    confirmation,
    observer,
  );
}

export function commandExecutionActive(config: AgentConfig): boolean {
  return config.commandExecutionEnabled && config.commandPolicy !== "disabled";
}

export function createVerifier(config: AgentConfig, runner: CommandRunner): ProjectVerifier {
  return new ProjectVerifier(
    {
      workspaceRoot: config.workspace,
      commandTimeoutMs: config.commandTimeoutMs,
      testTimeoutMs: config.testTimeoutMs,
      buildTimeoutMs: config.buildTimeoutMs,
      baselineEnabled: config.verificationBaseline,
      accessMode: config.accessMode,
    },
    runner,
  );
}

export function createRegistry(
  workspace: WorkspaceService,
  changes: LocalChangeService,
  runner: CommandRunner,
  verifier: ProjectVerifier,
  coordinator: VerificationCoordinator,
  config: AgentConfig,
  options: {
    includeWorkspaceTools?: boolean;
    includeChangeTools?: boolean;
    allowApplyTools?: boolean;
  } = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(getPlatformInfoTool);
  registry.register(getCurrentTimeTool);
  if (options.includeWorkspaceTools !== false) registerWorkspaceTools(registry, workspace);
  if (options.includeChangeTools !== false) {
    registerChangeTools(registry, changes, {
      allowFileDelete: config.allowFileDelete,
      allowFileMove: config.allowFileMove,
      beforeApply: () => coordinator.beforeApply(),
      afterApply: (result) => coordinator.afterApply(result),
      allowApply: options.allowApplyTools !== false,
    });
  }
  registerCommandTools(registry, runner, verifier, {
    enabled: config.commandExecutionEnabled && config.commandPolicy !== "disabled",
    verificationEnabled: config.verificationEnabled,
  });
  return registry;
}

function isRemoteCommand(positionals: readonly string[]): boolean {
  return positionals[0] === "github" || positionals[0] === "task";
}

function isOrchestrationCommand(positionals: readonly string[]): boolean {
  return positionals[0] === "orchestrate" || positionals[0] === "orchestration";
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function runOrchestrationCommand(
  config: AgentConfig,
  positionals: readonly string[],
  mode: "analysis" | "implementation" | "autonomous" | undefined,
): Promise<number> {
  const service = await OrchestrationRuntimeService.create(config);
  const [root, command, sessionId] = positionals;
  if (root === "orchestrate") {
    const task = positionals.slice(1).join(" ").trim();
    if (task === "") throw new ConfigurationError("Komenda orchestrate wymaga treści zadania.");
    const session = await service.createSession({ task, mode: mode ?? "analysis" });
    printJson(session);
    console.log(
      `\nPlan oczekuje na zatwierdzenie: npm run agent -- orchestration approve ${session.id}`,
    );
    return 0;
  }
  if (root !== "orchestration") throw new ConfigurationError("Nieznana komenda orkiestracji.");
  if (command === "list") {
    printJson(await service.list());
    return 0;
  }
  if (sessionId === undefined)
    throw new ConfigurationError(`Komenda orchestration ${command ?? ""} wymaga sessionId.`);
  switch (command) {
    case "status":
      printJson(await service.get(sessionId));
      return 0;
    case "plan":
      printJson(await service.plan(sessionId));
      return 0;
    case "approve": {
      const session = await service.get(sessionId);
      printJson(
        session.state === "awaiting_plan_approval"
          ? await service.approvePlanAndRun(sessionId, "user_cli")
          : await service.approveResult(sessionId, "user_cli"),
      );
      return 0;
    }
    case "reject": {
      const session = await service.get(sessionId);
      printJson(
        session.state === "awaiting_plan_approval"
          ? await service.rejectPlan(sessionId)
          : await service.rejectResult(sessionId),
      );
      return 0;
    }
    case "graph":
      printJson(await service.graph(sessionId));
      return 0;
    case "agents":
      printJson(await service.agents(sessionId));
      return 0;
    case "artifacts":
      printJson(await service.artifacts(sessionId));
      return 0;
    case "conflicts":
      printJson(await service.conflicts(sessionId));
      return 0;
    case "review":
      printJson(await service.review(sessionId));
      return 0;
    case "cancel":
      printJson(await service.cancel(sessionId));
      return 0;
    case "resume":
      printJson(await service.resumeAndRun(sessionId));
      return 0;
    default:
      throw new ConfigurationError("Nieznana komenda orchestration.");
  }
}

async function runRemoteCommand(
  config: AgentConfig,
  sessionId: string,
  positionals: readonly string[],
  assumeYes: boolean,
  signal: AbortSignal,
): Promise<number> {
  const remote = new RemoteRuntimeService(config, sessionId);
  const [root, second, third, fourth, fifth] = positionals;
  if (root === "github" && second === "status" && !config.remoteEnabled) {
    printJson(await remote.status());
    return 0;
  }
  try {
    const user = await remote.authenticateWithEnvironment();
    if (root === "github") {
      switch (`${second ?? "status"}:${third ?? ""}`) {
        case "status:": {
          await remote.verifyRepository();
          printJson(await remote.status());
          return 0;
        }
        case "auth:status":
          printJson({
            authenticated: true,
            user: { login: user.login, ...(user.name === undefined ? {} : { name: user.name }) },
          });
          return 0;
        case "repository:":
          printJson((await remote.verifyRepository()).repository);
          return 0;
        case "permissions:":
          printJson((await remote.verifyRepository()).permissions);
          return 0;
        case "rate-limit:":
          printJson(await remote.rateLimit());
          return 0;
        default:
          throw new ConfigurationError("Nieznana komenda github.");
      }
    }

    if (root !== "task") throw new ConfigurationError("Nieznana komenda remote.");
    if ((second === "publish" || second === "push") && third !== undefined) {
      const prepared = await remote.preparePublish(third);
      console.log(`Repozytorium: ${prepared.repository.owner}/${prepared.repository.repository}`);
      console.log(`Remote: ${prepared.repository.remoteName}`);
      console.log(`Gałąź: ${prepared.branch}`);
      console.log(`Commity: ${prepared.commits}`);
      console.log("Operacja nie użyje force push.");
      const approved =
        assumeYes || (await askConfirmation("Opublikować gałąź zwykłym push? [t/N] ", signal));
      printJson(await remote.executePublish(prepared, approved));
      return 0;
    }

    if (second !== "pr" || third === undefined || fourth === undefined) {
      throw new ConfigurationError("Niepełna komenda task pr.");
    }
    const taskId = fourth;
    switch (third) {
      case "create": {
        const prepared = await remote.prepareCreatePullRequest(taskId);
        console.log(`Repozytorium: ${prepared.repository.owner}/${prepared.repository.repository}`);
        console.log(`Head: ${prepared.manifest.branch}`);
        console.log(`Base: ${prepared.manifest.baseBranch}`);
        console.log("Typ: Draft Pull Request");
        console.log(`Tytuł: ${prepared.title}`);
        console.log(`\n${prepared.body}`);
        const approved =
          assumeYes || (await askConfirmation("Utworzyć ten Draft Pull Request? [t/N] ", signal));
        printJson(await remote.executeCreatePullRequest(prepared, approved));
        return 0;
      }
      case "status":
        printJson(await remote.getPullRequest(taskId));
        return 0;
      case "checks":
        printJson(await remote.listChecks(taskId));
        return 0;
      case "watch":
        printJson(await remote.watchChecks(taskId, signal));
        return 0;
      case "logs":
        if (fifth === undefined) throw new ConfigurationError("Podaj checkId.");
        printJson(await remote.getCheckLogs(taskId, fifth));
        return 0;
      case "analyze":
        if (fifth === undefined) throw new ConfigurationError("Podaj checkId.");
        printJson(await remote.analyzeCheck(taskId, fifth));
        return 0;
      case "reviews":
      case "threads":
        printJson(await remote.listReviewThreads(taskId));
        return 0;
      case "reply": {
        if (fifth === undefined) throw new ConfigurationError("Podaj threadId.");
        const body = await askText("Treść odpowiedzi (bez sekretów): ", signal);
        const commitSha = await askText("SHA opublikowanego commita: ", signal);
        const prepared = await remote.prepareReviewReply(taskId, fifth, body, commitSha);
        console.log(`Odpowiedź:\n${body}\nCommit: ${commitSha}`);
        const approved =
          assumeYes || (await askConfirmation("Wysłać tę odpowiedź? [t/N] ", signal));
        printJson(
          await remote.executeReviewReply({
            taskId,
            threadId: fifth,
            body,
            commitSha,
            approvalId: prepared.approvalId,
            approved,
          }),
        );
        return 0;
      }
      case "resolve": {
        if (fifth === undefined) throw new ConfigurationError("Podaj threadId.");
        const prepared = await remote.prepareResolveThread(taskId, fifth);
        const approved =
          assumeYes ||
          (await askConfirmation("Oznaczyć ten wątek jako rozwiązany? [t/N] ", signal));
        await remote.executeResolveThread({
          taskId,
          threadId: fifth,
          approvalId: prepared.approvalId,
          approved,
        });
        printJson({ resolved: true, threadId: fifth });
        return 0;
      }
      default:
        throw new ConfigurationError("Nieznana komenda task pr.");
    }
  } finally {
    remote.disconnect();
  }
}

async function runDoctor(
  config: AgentConfig,
  client: OllamaClient,
  workspace: WorkspaceService,
  runner: CommandRunner,
  verifier: ProjectVerifier,
  signal: AbortSignal,
  githubRead = false,
  orchestrationTest = false,
): Promise<number> {
  console.log(`Node.js: OK, ${process.version}`);
  try {
    await client.checkAvailability(signal);
    console.log(`Ollama: OK`);
    console.log(`Model: OK, ${config.ollamaModel}`);
  } catch (error: unknown) {
    console.log(
      `Ollama/model: BŁĄD — ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
  console.log(`Workspace: OK, ${config.workspace}`);
  const git = await workspace.getGitStatus().catch(() => ({ isRepository: false }));
  console.log(`Git: ${git.isRepository ? "repozytorium wykryte" : "brak repozytorium lub Git"}`);
  const shells = await new ShellDetector(runner.getResolver()).detect();
  console.log(`Powłoki: ${shells.availableShells.join(", ") || "brak wykrytych"}`);
  const manager = await new PackageManagerDetector(config.workspace, runner.getResolver()).detect();
  console.log(`Menedżer pakietów: ${manager.type} (${manager.confidence})`);
  const detection = await verifier.detectProjectCommands();
  for (const category of ["test", "lint", "typecheck", "build", "format"] as const) {
    const command = detection.commands.find((item) => item.category === category && item.allowed);
    console.log(
      `${category}: ${command === undefined ? "niedostępne" : `${command.executable} ${command.args.join(" ")}`}`,
    );
  }
  console.log(
    `Zablokowane wykryte polecenia: ${detection.commands.filter((item) => !item.allowed).length}`,
  );
  if (commandExecutionActive(config)) {
    const node = await runner.getResolver().resolve("node");
    if (node.available && node.resolvedPath !== undefined) {
      const result = await runner.run(
        {
          id: "doctor:node-version",
          category: "version",
          executable: node.resolvedPath,
          args: ["--version"],
          cwd: config.workspace,
          timeoutMs: 10_000,
          networkAccess: false,
          writesFiles: false,
          source: "built_in",
          displayName: "Node.js version",
        },
        { accessMode: config.accessMode },
        signal,
      );
      console.log(`Tworzenie procesu: ${result.status === "success" ? "OK" : result.status}`);
    }
  }
  console.log(`Sieć: ${config.allowNetwork ? "włączona" : "zablokowana"}`);
  console.log(`Instalacja pakietów: ${config.allowPackageInstall ? "włączona" : "zablokowana"}`);
  console.log(
    `Limit poleceń: ${config.maxCommandsPerSession}; równolegle: ${config.maxParallelCommands}`,
  );
  console.log(`Remote: ${config.remoteEnabled ? "włączony (github)" : "wyłączony"}`);
  console.log(`GitHub auth: ${config.githubAuthMode}`);
  console.log("Blokady remote: merge=blocked, force-push=blocked, branch-delete=blocked");
  if (githubRead && config.remoteEnabled) {
    const remote = new RemoteRuntimeService(config, `doctor-${randomUUID()}`);
    try {
      await remote.authenticateWithEnvironment();
      const verified = await remote.verifyRepository();
      console.log(`GitHub user: ${(await remote.status()).user === undefined ? "unknown" : "OK"}`);
      console.log(
        `GitHub repository: ${verified.repository.owner}/${verified.repository.repository}`,
      );
      console.log(
        `GitHub permissions: push=${verified.permissions.canPush}, comments=${verified.permissions.canComment}`,
      );
      console.log(`GitHub rate limit: ${JSON.stringify(await remote.rateLimit())}`);
    } catch (error: unknown) {
      console.log(
        `GitHub read checks: BŁĄD — ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      remote.disconnect();
    }
  }
  if (orchestrationTest) {
    const orchestration = await OrchestrationRuntimeService.create(config);
    const session = await orchestration.createSession({
      task: "Read-only doctor check: summarize the repository architecture.",
      mode: "analysis",
    });
    const report = await orchestration.approvePlanAndRun(session.id, "user_cli");
    console.log(`Orchestration: ${report.status}, session=${session.id}`);
  }
  return 0;
}

function displayError(error: unknown, debug: boolean): void {
  if (debug && error instanceof Error && error.stack !== undefined) console.error(error.stack);
  else console.error(error instanceof Error ? error.message : String(error));
}

export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const controller = new AbortController();
  const handleInterrupt = (): void => controller.abort();
  process.once("SIGINT", handleInterrupt);
  let debug = isDebugRequested();
  try {
    const cli = parseCliArguments(args);
    const config = await loadConfig({
      overrides: {
        ...(cli.workspace === undefined ? {} : { workspace: cli.workspace }),
        ...(cli.debug === undefined ? {} : { debug: cli.debug }),
        ...(cli.mode === undefined ? {} : { accessMode: cli.mode }),
        ...(cli.verificationEnabled === undefined
          ? {}
          : { verificationEnabled: cli.verificationEnabled }),
        ...(cli.baselineEnabled === undefined ? {} : { verificationBaseline: cli.baselineEnabled }),
        ...(cli.verificationScope === undefined
          ? {}
          : { verificationScope: cli.verificationScope }),
      },
    });
    debug = config.debug;
    const sessionId = randomUUID();
    if (isRemoteCommand(cli.positionals)) {
      return runRemoteCommand(config, sessionId, cli.positionals, cli.yes, controller.signal);
    }
    if (isOrchestrationCommand(cli.positionals)) {
      return runOrchestrationCommand(config, cli.positionals, cli.orchestrationMode);
    }
    const interactive = cli.task === "" && !cli.doctor;
    const client = new OllamaClient(config);
    const workspace = await LocalWorkspaceService.create({
      root: config.workspace,
      maxFileSizeBytes: config.maxFileSizeBytes,
      maxReadLines: config.maxReadLines,
      maxSearchResults: config.maxSearchResults,
      maxDirectoryDepth: config.maxDirectoryDepth,
      includeHiddenFiles: config.includeHiddenFiles,
      respectGitignore: config.respectGitignore,
      allowSensitiveFiles: config.allowSensitiveFiles,
    });
    const runner = createCommandRunner(
      config,
      sessionId,
      createCommandConfirmation({ interactive, assumeYes: cli.yes, signal: controller.signal }),
    );
    const verifier = createVerifier(config, runner);
    if (cli.doctor)
      return runDoctor(
        config,
        client,
        workspace,
        runner,
        verifier,
        controller.signal,
        cli.githubRead,
        cli.orchestrationTest,
      );

    const changes = await LocalChangeService.create({
      workspaceRoot: config.workspace,
      mode: config.accessMode,
      requireWriteConfirmation: config.requireWriteConfirmation,
      allowFileDelete: config.allowFileDelete,
      allowFileMove: config.allowFileMove,
      allowSensitiveFileWrite: config.allowSensitiveFileWrite,
      allowSymlinkWrite: config.allowSymlinkWrite,
      defaultEol: config.defaultEol,
      checkpointRetention: config.checkpointRetention,
      checkpointMaxTotalBytes: config.checkpointMaxTotalBytes,
      limits: {
        maxChangedFiles: config.maxChangedFiles,
        maxCreatedFileBytes: config.maxCreatedFileBytes,
        maxTotalWriteBytes: config.maxTotalWriteBytes,
        maxPatchReplacements: config.maxPatchReplacements,
        maxChangeOperations: config.maxChangeOperations,
        maxDiffChars: config.maxDiffChars,
      },
      sessionId,
      confirmationProvider: createChangeConfirmation({
        interactive,
        assumeYes: cli.yes,
        signal: controller.signal,
      }),
    });
    const coordinator = new VerificationCoordinator(verifier, changes, {
      enabled: config.verificationEnabled,
      verifyAfterApply: config.verifyAfterApply,
      rollbackOnFailure: config.rollbackOnVerificationFailure,
      maxRepairAttempts: config.maxRepairAttempts,
      scope: config.verificationScope,
    });

    await client.checkAvailability(controller.signal);
    console.log(`Model: ${config.ollamaModel}`);
    console.log(`Ollama: ${config.ollamaHost}`);
    console.log(`Workspace: ${config.workspace}`);
    console.log(`Tryb dostępu: ${config.accessMode}`);
    console.log(
      `Wykonywanie poleceń: ${commandExecutionActive(config) ? "włączone" : "wyłączone"}`,
    );
    console.log(`Polityka poleceń: ${config.commandPolicy}`);
    console.log(`Dostęp do sieci: ${config.allowNetwork ? "włączony" : "wyłączony"}`);
    console.log(`Instalacja pakietów: ${config.allowPackageInstall ? "włączona" : "wyłączona"}`);
    console.log(`Automatyczna weryfikacja: ${config.verifyAfterApply ? "włączona" : "wyłączona"}`);
    console.log(`Maksymalna liczba prób naprawy: ${config.maxRepairAttempts}`);

    if (
      commandExecutionActive(config) &&
      config.verificationEnabled &&
      config.verificationBaseline
    ) {
      const baseline = await verifier.createBaseline({
        scope: config.verificationScope,
        reason: "Baseline przed zmianami agenta.",
        signal: controller.signal,
      });
      console.log(`\nBaseline: ${baseline.baselineId} (${baseline.result.status})`);
    }

    const task = cli.task === "" ? await promptForTask(controller.signal) : cli.task;
    if (task.trim() === "") throw new ConfigurationError("Zadanie nie może być puste.");
    await changes.createChangeSet({ task });
    const commandStatistics = () => ({
      ...runner.getStatistics(),
      ...verifier.getStatistics(),
    });
    const agent = new AgentLoop(
      client,
      createRegistry(workspace, changes, runner, verifier, coordinator, config),
      {
        defaultMaxSteps: config.maxSteps,
        maxModelCalls: config.maxModelCalls,
        maxFilesPerTask: config.maxFilesPerTask,
        maxContextChars: config.contextLength * 4,
        maxTaskDurationMs: config.maxTaskDurationMs,
        maxToolResultChars: config.maxToolResultChars,
        debug: config.debug,
        changeSession: () => changes.getSessionSnapshot(),
        verificationSession: () => coordinator.snapshot(),
        commandStatistics,
      },
    );
    const result = await agent.run({ task, signal: controller.signal });

    console.log("\nOdpowiedź:\n");
    console.log(result.answer);
    const preview = changes.getLastPreview();
    if (
      preview !== undefined &&
      !["changes_applied", "verification_passed"].includes(result.finishReason)
    ) {
      displayChangePreview(preview);
    }
    if (result.changeSummary?.checkpointId !== undefined) {
      console.log(`\nCheckpoint: ${result.changeSummary.checkpointId}`);
    }
    const report = coordinator.snapshot().report;
    if (report !== undefined) console.log(`\n${verificationReport(report)}`);
    console.log(`\nKroki agenta: ${result.steps}`);
    console.log(`Wywołania narzędzi: ${result.toolCalls}`);
    console.log(`Polecenia: ${result.commandStatistics.commandsRun}`);
    console.log(`Polecenia zablokowane: ${result.commandStatistics.commandsBlocked}`);
    console.log(`Weryfikacje: ${result.commandStatistics.verificationRuns}`);
    console.log(`Regresje: ${result.commandStatistics.regressionsDetected}`);
    console.log(`Czas wykonania: ${(result.durationMs / 1_000).toLocaleString("pl-PL")} s`);
    console.log(`Faza: ${result.phase}`);
    console.log(`Wynik: ${result.finishReason}`);

    if (result.finishReason === "aborted") return 130;
    if (
      [
        "error",
        "max_steps",
        "verification_failed",
        "max_repair_attempts",
        "command_limit_reached",
      ].includes(result.finishReason)
    )
      return 1;
    return 0;
  } catch (error: unknown) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      console.error("\nDziałanie zostało przerwane.");
      return 130;
    }
    displayError(error, debug);
    return 1;
  } finally {
    process.removeListener("SIGINT", handleInterrupt);
  }
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { ConfigurationError } from "../src/errors.js";

const temporaryDirectories: string[] = [];

async function configFile(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-code-agent-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "default.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("loadConfig", () => {
  it("łączy wartości domyślne z plikiem konfiguracji", async () => {
    const path = await configFile({ maxSteps: 7, ollamaModel: "test-model:1b" });

    const result = await loadConfig({ configPath: path, env: {} });

    expect(result).toMatchObject({
      ollamaHost: "http://127.0.0.1:11434",
      ollamaModel: "test-model:1b",
      profile: "low-resource",
      maxParallelAgents: 1,
      maxModelCalls: 8,
      maxSteps: 7,
      contextLength: 8_192,
      temperature: 0.1,
      debug: false,
      accessMode: "preview",
      requireWriteConfirmation: true,
      allowFileDelete: false,
      allowFileMove: true,
      commandExecutionEnabled: true,
      commandPolicy: "verification",
      allowNetwork: false,
      allowPackageInstall: false,
      verificationEnabled: true,
      verificationBaseline: true,
      maxRepairAttempts: 3,
      verifyAfterApply: true,
      rollbackOnVerificationFailure: false,
      verificationScope: "affected_packages",
    });
  });

  it("stosuje domyĹ›lny profil niskiego zuĹĽycia zasobĂłw", async () => {
    const path = await configFile({});
    const result = await loadConfig({ configPath: path, env: {} });

    expect(result).toMatchObject({
      profile: "low-resource",
      maxParallelAgents: 1,
      maxParallelProcesses: 1,
      maxAgentSteps: 12,
      maxModelCalls: 8,
      maxFilesPerTask: 30,
      maxFileSizeBytes: 512 * 1_024,
      maxCommandOutputBytes: 256 * 1_024,
      workspaceIndexing: "incremental",
      ollamaKeepAlive: "3m",
      maxLoadedModels: 1,
      orchestrationMaxParallelAgents: 1,
    });
  });

  it("udostÄ™pnia profil balanced bez zmiany profilu domyĹ›lnego", async () => {
    const path = await configFile({ profile: "balanced" });
    const result = await loadConfig({ configPath: path, env: {} });

    expect(result).toMatchObject({
      profile: "balanced",
      maxParallelAgents: 2,
      maxParallelProcesses: 2,
      maxModelCalls: 16,
      contextLength: 16_384,
      orchestrationMaxParallelAgents: 2,
    });
  });

  it("nadaje zmiennym środowiskowym najwyższy priorytet", async () => {
    const path = await configFile({ maxSteps: 7, debug: false });

    const result = await loadConfig({
      configPath: path,
      env: {
        OLLAMA_HOST: "http://localhost:9999",
        OLLAMA_MODEL: "env-model:latest",
        AGENT_MAX_STEPS: "12",
        AGENT_CONTEXT_LENGTH: "65536",
        AGENT_TEMPERATURE: "0.25",
        AGENT_DEBUG: "true",
        AGENT_WORKSPACE: dirname(path),
        AGENT_MAX_FILE_SIZE_BYTES: "2048",
        AGENT_MAX_READ_LINES: "50",
        AGENT_MAX_SEARCH_RESULTS: "25",
        AGENT_MAX_DIRECTORY_DEPTH: "6",
        AGENT_INCLUDE_HIDDEN_FILES: "true",
        AGENT_RESPECT_GITIGNORE: "false",
        AGENT_ALLOW_SENSITIVE_FILES: "true",
        AGENT_MAX_TOOL_RESULT_CHARS: "12000",
      },
    });

    expect(result).toMatchObject({
      ollamaHost: "http://localhost:9999",
      ollamaModel: "env-model:latest",
      maxSteps: 12,
      contextLength: 65_536,
      temperature: 0.25,
      debug: true,
      workspace: resolve(dirname(path)),
      maxFileSizeBytes: 2_048,
      maxReadLines: 50,
      maxSearchResults: 25,
      maxDirectoryDepth: 6,
      includeHiddenFiles: true,
      respectGitignore: false,
      allowSensitiveFiles: true,
      maxToolResultChars: 12_000,
    });
  });

  it("odrzuca błędną konfigurację i wskazuje pole", async () => {
    const path = await configFile({ ollamaHost: "ftp://invalid", maxSteps: 0 });

    await expect(loadConfig({ configPath: path, env: {} })).rejects.toMatchObject({
      name: ConfigurationError.name,
      message: expect.stringContaining("ollamaHost"),
    });
    await expect(loadConfig({ configPath: path, env: {} })).rejects.toThrow("maxSteps");
  });

  it("nadaje nadpisaniu CLI pierwszeństwo przed środowiskiem", async () => {
    const path = await configFile({});
    const result = await loadConfig({
      configPath: path,
      env: { AGENT_WORKSPACE: process.cwd(), AGENT_DEBUG: "false" },
      overrides: { workspace: dirname(path), debug: true },
    });
    expect(result.workspace).toBe(resolve(dirname(path)));
    expect(result.debug).toBe(true);
  });

  it("odrzuca nieistniejący workspace", async () => {
    const path = await configFile({ workspace: join(tmpdir(), "definitely-missing-workspace") });
    await expect(loadConfig({ configPath: path, env: {} })).rejects.toMatchObject({
      code: "WORKSPACE_NOT_FOUND",
    });
  });

  it("wczytuje konfigurację bezpiecznego zapisu ze środowiska", async () => {
    const path = await configFile({});
    const result = await loadConfig({
      configPath: path,
      env: {
        AGENT_WORKSPACE: dirname(path),
        AGENT_ACCESS_MODE: "write",
        AGENT_REQUIRE_WRITE_CONFIRMATION: "false",
        AGENT_ALLOW_FILE_DELETE: "true",
        AGENT_DEFAULT_EOL: "crlf",
        AGENT_MAX_CHANGED_FILES: "7",
        AGENT_MAX_TOTAL_WRITE_BYTES: "4096",
      },
    });
    expect(result).toMatchObject({
      accessMode: "write",
      requireWriteConfirmation: false,
      allowFileDelete: true,
      defaultEol: "crlf",
      maxChangedFiles: 7,
      maxTotalWriteBytes: 4_096,
    });
  });

  it("odrzuca nieznany tryb dostępu", async () => {
    const path = await configFile({ accessMode: "unsafe" });
    await expect(loadConfig({ configPath: path, env: {} })).rejects.toThrow("accessMode");
  });

  it("wczytuje limity poleceń i weryfikacji ze środowiska", async () => {
    const path = await configFile({});
    const result = await loadConfig({
      configPath: path,
      env: {
        AGENT_WORKSPACE: dirname(path),
        AGENT_COMMAND_POLICY: "restricted",
        AGENT_COMMAND_TIMEOUT_MS: "45000",
        AGENT_TEST_TIMEOUT_MS: "90000",
        AGENT_BUILD_TIMEOUT_MS: "120000",
        AGENT_MAX_COMMAND_OUTPUT_CHARS: "20000",
        AGENT_MAX_COMMAND_OUTPUT_LINES: "800",
        AGENT_MAX_COMMAND_OUTPUT_BYTES: "50000",
        AGENT_MAX_COMMANDS_PER_SESSION: "9",
        AGENT_MAX_PARALLEL_COMMANDS: "2",
        AGENT_ALLOWED_ENV_VARS: "PATH,TEMP,SystemRoot",
        AGENT_VERIFICATION_BASELINE: "false",
        AGENT_MAX_REPAIR_ATTEMPTS: "2",
        AGENT_ROLLBACK_ON_VERIFICATION_FAILURE: "true",
        AGENT_VERIFICATION_SCOPE: "workspace",
      },
    });

    expect(result).toMatchObject({
      commandPolicy: "restricted",
      commandTimeoutMs: 45_000,
      testTimeoutMs: 90_000,
      buildTimeoutMs: 120_000,
      maxCommandOutputChars: 20_000,
      maxCommandOutputLines: 800,
      maxCommandOutputBytes: 50_000,
      maxCommandsPerSession: 9,
      maxParallelCommands: 2,
      allowedEnvVars: ["PATH", "TEMP", "SystemRoot"],
      verificationBaseline: false,
      maxRepairAttempts: 2,
      rollbackOnVerificationFailure: true,
      verificationScope: "workspace",
    });
  });

  it("odrzuca nieznaną politykę i scope weryfikacji", async () => {
    const invalidPolicy = await configFile({ commandPolicy: "terminal" });
    await expect(loadConfig({ configPath: invalidPolicy, env: {} })).rejects.toThrow(
      "commandPolicy",
    );
    const invalidScope = await configFile({ verificationScope: "repository" });
    await expect(loadConfig({ configPath: invalidScope, env: {} })).rejects.toThrow(
      "verificationScope",
    );
  });

  it("wczytuje modele, limity i bramki orkiestracji ze środowiska", async () => {
    const path = await configFile({});
    const result = await loadConfig({
      configPath: path,
      env: {
        AGENT_WORKSPACE: dirname(path),
        AGENT_ORCHESTRATION_MODEL_DEFAULT: "orchestrator:latest",
        AGENT_ORCHESTRATION_MODEL_TEST: "tests:latest",
        AGENT_ORCHESTRATION_MAX_AGENTS: "6",
        AGENT_ORCHESTRATION_MAX_PARALLEL_AGENTS: "2",
        AGENT_ORCHESTRATION_MAX_TOTAL_CONTEXT_TOKENS: "120000",
        AGENT_ORCHESTRATION_CONSENSUS_THRESHOLD: "0.75",
        AGENT_ORCHESTRATION_REQUIRE_PLAN_APPROVAL: "true",
        AGENT_ORCHESTRATION_REQUIRE_FINAL_APPROVAL: "true",
      },
    });
    expect(result).toMatchObject({
      orchestrationModelDefault: "orchestrator:latest",
      orchestrationModelTest: "tests:latest",
      orchestrationMaxAgents: 6,
      orchestrationMaxParallelAgents: 2,
      orchestrationMaxTotalContextTokens: 120_000,
      orchestrationConsensusThreshold: 0.75,
      orchestrationRequirePlanApproval: true,
      orchestrationRequireFinalApproval: true,
      orchestrationAllowParallelWrites: false,
    });
  });

  it("bezwarunkowo odrzuca równoległe zapisy specjalistów", async () => {
    const path = await configFile({});
    await expect(
      loadConfig({
        configPath: path,
        env: {
          AGENT_WORKSPACE: dirname(path),
          AGENT_ORCHESTRATION_ALLOW_PARALLEL_WRITES: "true",
        },
      }),
    ).rejects.toThrow("orchestrationAllowParallelWrites");
  });
});

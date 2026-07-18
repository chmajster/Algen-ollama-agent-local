import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandRunner } from "@local-code-agent/command-runner";
import { ProjectVerifier } from "@local-code-agent/project-verifier";
import type {
  AgentMessage,
  AgentModelClient,
  ModelChatRequest,
  ModelChatResponse,
  ModelToolCall,
} from "@local-code-agent/shared-types";

import { AgentLoop } from "../src/agent/agentLoop.js";
import { registerCommandTools } from "../src/tools/commandTools.js";
import { ToolRegistry } from "../src/tools/toolRegistry.js";

function call(name: string, args: unknown): ModelToolCall {
  return { function: { name, arguments: args } };
}

function response(content: string, toolCalls?: ModelToolCall[]): ModelChatResponse {
  return {
    message: {
      role: "assistant",
      content,
      ...(toolCalls === undefined ? {} : { toolCalls }),
    },
  };
}

class QueueClient implements AgentModelClient {
  public readonly requests: ModelChatRequest[] = [];

  public constructor(private readonly responses: ModelChatResponse[]) {}

  public async checkAvailability(): Promise<void> {}

  public async chat(request: ModelChatRequest): Promise<ModelChatResponse> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("Brak odpowiedzi modelu.");
    return next;
  }
}

function toolMessages(request: ModelChatRequest | undefined): AgentMessage[] {
  return request?.messages.filter((message) => message.role === "tool") ?? [];
}

describe("narzędzia poleceń i AgentLoop", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "command-tools-"));
    await mkdir(join(root, "scripts"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "command-tools-fixture",
        version: "1.0.0",
        scripts: {
          test: "node scripts/test.cjs",
          typecheck: "node scripts/typecheck.cjs",
        },
      }),
    );
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({ name: "command-tools-fixture", lockfileVersion: 3, packages: {} }),
    );
    await writeFile(join(root, "scripts", "test.cjs"), 'console.log("Tests  1 passed")\n');
    await writeFile(join(root, "scripts", "typecheck.cjs"), 'console.log("typecheck passed")\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function services(options: { maxCommands?: number; testTimeoutMs?: number } = {}) {
    const runner = new CommandRunner({
      workspaceRoot: root,
      sessionId: "command-tools-test",
      policy: {
        enabled: true,
        policy: "verification",
        allowNetwork: false,
        allowPackageInstall: false,
        allowPackageScripts: true,
        allowCustomCommands: false,
        allowFormatCommands: true,
        maxCommandsPerSession: options.maxCommands ?? 30,
      },
      outputLimits: { maxChars: 10_000, maxLines: 1_000, maxBytes: 100_000 },
      maxParallelCommands: 1,
      allowEnvOverrides: false,
      allowedEnvVars: [
        "PATH",
        "HOME",
        "USERPROFILE",
        "TEMP",
        "TMP",
        "SystemRoot",
        "COMSPEC",
        "PATHEXT",
      ],
    });
    const verifier = new ProjectVerifier(
      {
        workspaceRoot: root,
        commandTimeoutMs: 5_000,
        testTimeoutMs: options.testTimeoutMs ?? 5_000,
        buildTimeoutMs: 5_000,
        baselineEnabled: false,
        accessMode: "readonly",
      },
      runner,
    );
    return { runner, verifier };
  }

  function registry(
    runner: CommandRunner,
    verifier: ProjectVerifier,
    enabled = true,
  ): ToolRegistry {
    const tools = new ToolRegistry();
    registerCommandTools(tools, runner, verifier, {
      enabled,
      verificationEnabled: enabled,
    });
    return tools;
  }

  it("pozostawia narzędzia odczytowe, gdy wykonywanie procesów jest wyłączone", () => {
    const { runner, verifier } = services();
    const tools = registry(runner, verifier, false);

    expect(tools.has("detect_project_commands")).toBe(true);
    expect(tools.has("get_command_history")).toBe(true);
    expect(tools.has("get_verification_report")).toBe(true);
    expect(tools.has("run_tests")).toBe(false);
    expect(tools.has("run_verification")).toBe(false);
  });

  it("prowadzi agenta przez detekcję, test, typecheck i pełną weryfikację", async () => {
    const { runner, verifier } = services();
    const client = new QueueClient([
      response("", [call("detect_project_commands", {})]),
      response("", [call("run_tests", { reason: "Uruchom testy projektu." })]),
      response("", [call("run_typecheck", { reason: "Uruchom typecheck projektu." })]),
      response("", [
        call("run_verification", {
          scope: "workspace",
          include: ["tests", "typecheck"],
          reason: "Końcowa weryfikacja projektu.",
        }),
      ]),
      response("Weryfikacja zakończona."),
    ]);

    const result = await new AgentLoop(client, registry(runner, verifier), {
      defaultMaxSteps: 10,
      commandStatistics: () => ({ ...runner.getStatistics(), ...verifier.getStatistics() }),
    }).run({ task: "Sprawdź projekt" });

    expect(result).toMatchObject({ finishReason: "completed", toolCalls: 4 });
    expect(result.commandStatistics).toMatchObject({
      commandsRun: 4,
      verificationRuns: 1,
      verificationSteps: 2,
    });
    const finalTools = toolMessages(client.requests[4]);
    expect(finalTools.some((message) => message.content.includes('"status":"passed"'))).toBe(true);
    expect(finalTools.some((message) => message.content.includes('"testsPassed":1'))).toBe(true);
  });

  it("przekazuje stabilną blokadę nieznanego identyfikatora do modelu", async () => {
    const { runner, verifier } = services();
    const client = new QueueClient([
      response("", [
        call("run_project_command", {
          commandId: "arbitrary:command",
          reason: "Próba nieznanego polecenia.",
        }),
      ]),
      response("Polecenie zostało zablokowane."),
    ]);

    await new AgentLoop(client, registry(runner, verifier), { defaultMaxSteps: 5 }).run({
      task: "Uruchom polecenie",
    });

    expect(toolMessages(client.requests[1])[0]?.content).toContain(
      '"code":"UNSUPPORTED_PROJECT_COMMAND"',
    );
  });

  it("przekazuje timeout i statystyki wyliczone przez runtime", async () => {
    await writeFile(join(root, "scripts", "test.cjs"), "setInterval(() => undefined, 1000)\n");
    const { runner, verifier } = services({ testTimeoutMs: 100 });
    const client = new QueueClient([
      response("", [call("run_tests", { reason: "Kontrolowany test timeoutu." })]),
      response("Test został przerwany przez timeout."),
    ]);

    const result = await new AgentLoop(client, registry(runner, verifier), {
      defaultMaxSteps: 5,
      commandStatistics: () => ({ ...runner.getStatistics(), ...verifier.getStatistics() }),
    }).run({ task: "Sprawdź timeout" });

    expect(toolMessages(client.requests[1])[0]?.content).toContain('"status":"timeout"');
    expect(result.commandStatistics).toMatchObject({ commandsRun: 1, commandsTimedOut: 1 });
  });

  it("kończy sesję stabilnym wynikiem po osiągnięciu limitu poleceń", async () => {
    const { runner, verifier } = services({ maxCommands: 1 });
    const client = new QueueClient([
      response("", [call("run_tests", { reason: "Pierwsze polecenie sesji." })]),
      response("", [call("run_typecheck", { reason: "Polecenie ponad limitem." })]),
      response("Limit poleceń został osiągnięty."),
    ]);

    const result = await new AgentLoop(client, registry(runner, verifier), {
      defaultMaxSteps: 5,
      commandStatistics: () => ({ ...runner.getStatistics(), ...verifier.getStatistics() }),
    }).run({ task: "Sprawdź limit" });

    expect(result.finishReason).toBe("command_limit_reached");
    expect(toolMessages(client.requests[2])[1]?.content).toContain(
      '"code":"COMMAND_LIMIT_EXCEEDED"',
    );
    expect(result.commandStatistics).toMatchObject({ commandsRun: 1, commandsBlocked: 1 });
  });
});

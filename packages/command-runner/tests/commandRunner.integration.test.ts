import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandRunner, type CommandSpec } from "../src/index.js";

describe("CommandRunner integration", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "command-runner-integration-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function createRunner(maxCommandsPerSession = 3): CommandRunner {
    return new CommandRunner({
      workspaceRoot: root,
      sessionId: "controlled-session",
      policy: {
        enabled: true,
        policy: "verification",
        allowNetwork: false,
        allowPackageInstall: false,
        allowPackageScripts: true,
        allowCustomCommands: false,
        allowFormatCommands: true,
        maxCommandsPerSession,
      },
      outputLimits: { maxChars: 1_000, maxLines: 100, maxBytes: 10_000 },
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
  }

  function command(id: string, code: string): CommandSpec {
    return {
      id,
      category: "diagnostic",
      executable: process.execPath,
      args: ["-e", code],
      cwd: root,
      timeoutMs: 5_000,
      networkAccess: false,
      writesFiles: false,
      source: "built_in",
    };
  }

  it("uruchamia zatwierdzony proces i zapisuje wyłącznie metadane historii", async () => {
    const runner = createRunner();
    const result = await runner.run(
      command("safe-node", 'console.log(["controlled","output"].join("-"))'),
      {
        accessMode: "readonly",
        reason: "Kontrolowana diagnostyka.",
      },
    );

    expect(result).toMatchObject({ status: "success", exitCode: 0 });
    expect(result.stdout).toContain("controlled-output");
    const history = await runner.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).not.toHaveProperty("stdout");
    expect(history[0]).not.toHaveProperty("stderr");
    expect(await readFile(join(root, ".agent", "history", "commands.jsonl"), "utf8")).not.toContain(
      "controlled-output",
    );
  });

  it("blokuje wskazanie sieci zanim powstanie proces", async () => {
    const runner = createRunner();
    await expect(
      runner.run(command("network", 'fetch("https://example.invalid")'), {
        accessMode: "readonly",
      }),
    ).rejects.toMatchObject({ code: "COMMAND_POLICY_VIOLATION" });

    expect(runner.getStatistics()).toMatchObject({ commandsRun: 0, commandsBlocked: 1 });
    expect(await runner.getHistory()).toEqual([
      expect.objectContaining({ commandId: "network", decision: "blocked" }),
    ]);
  });

  it("zwraca osobny stabilny błąd po wyczerpaniu limitu sesji", async () => {
    const runner = createRunner(1);
    await runner.run(command("first", 'console.log("first")'), { accessMode: "readonly" });

    await expect(
      runner.run(command("second", 'console.log("second")'), { accessMode: "readonly" }),
    ).rejects.toMatchObject({ code: "COMMAND_LIMIT_EXCEEDED", details: { limit: 1 } });
    expect(runner.getStatistics()).toMatchObject({ commandsRun: 1, commandsBlocked: 1 });
  });
});

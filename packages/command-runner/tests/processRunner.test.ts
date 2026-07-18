import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandLimitExceededError, ProcessRunner, type CommandSpec } from "../src/index.js";

describe("ProcessRunner", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "process-runner-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function spec(code: string, timeoutMs = 2_000): CommandSpec {
    return {
      id: "node-test",
      category: "diagnostic",
      executable: process.execPath,
      args: ["-e", code],
      cwd: root,
      timeoutMs,
      networkAccess: false,
      writesFiles: false,
      source: "built_in",
    };
  }

  function runner(maxParallelCommands = 1) {
    return new ProcessRunner({
      outputLimits: { maxChars: 1_000, maxLines: 100, maxBytes: 1_000 },
      maxParallelCommands,
    });
  }

  it("uruchamia poprawny proces bez powłoki", async () => {
    const result = await runner().run(spec("console.log('ok')"), process.env);
    expect(result).toMatchObject({ status: "success", exitCode: 0, stdout: "ok\n" });
  });

  it("zwraca niezerowy kod wyjścia", async () => {
    const result = await runner().run(spec("process.exit(7)"), process.env);
    expect(result).toMatchObject({ status: "failed", exitCode: 7 });
  });

  it("przechwytuje stdout i stderr osobno", async () => {
    const result = await runner().run(
      spec("process.stdout.write('out'); process.stderr.write('err')"),
      process.env,
    );
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("kończy proces po timeout", async () => {
    const result = await runner().run(spec("setInterval(() => {}, 1000)", 50), process.env);
    expect(result.status).toBe("timeout");
    expect(result.durationMs).toBeLessThan(2_000);
  });

  it("obsługuje AbortSignal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const result = await runner().run(
      spec("setInterval(() => {}, 1000)", 2_000),
      process.env,
      controller.signal,
    );
    expect(result.status).toBe("aborted");
  });

  it("zwraca spawn_error dla nieistniejącego executable", async () => {
    const result = await runner().run(
      { ...spec(""), executable: join(root, "missing-executable") },
      process.env,
    );
    expect(result.status).toBe("spawn_error");
  });

  it("zamyka stdin procesu", async () => {
    const result = await runner().run(
      spec("process.stdin.resume(); process.stdin.once('end', () => console.log('closed'))"),
      process.env,
    );
    expect(result.stdout).toContain("closed");
  });

  it("nie interpretuje operatorów powłoki w argumentach", async () => {
    const command = spec("console.log(process.argv[1])");
    command.args.push("a; echo UNSAFE");
    const result = await runner().run(command, process.env);
    expect(result.stdout).toBe("a; echo UNSAFE\n");
  });

  it("ustawia poprawny cwd", async () => {
    const result = await runner().run(spec("console.log(process.cwd())"), process.env);
    expect(result.stdout.trim()).toBe(root);
  });

  it("egzekwuje limit równoległości", async () => {
    const subject = runner(1);
    const first = subject.run(spec("setTimeout(() => {}, 100)", 1_000), process.env);
    await expect(subject.run(spec("console.log('second')"), process.env)).rejects.toBeInstanceOf(
      CommandLimitExceededError,
    );
    await first;
  });

  it("ogranicza przechowywane wyjście, ale pozwala procesowi się zakończyć", async () => {
    const result = await runner().run(spec("console.log('x'.repeat(10000))"), process.env);
    expect(result.status).toBe("success");
    expect(result.outputTruncated).toBe(true);
    expect(result.outputBytes).toBeGreaterThan(1_000);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DefaultGitCommandRunner,
  GitNotAvailableError,
  GitTimeoutError,
  readGitStatus,
  WorkspaceAccessError,
} from "../src/index.js";
import type { GitCommandResult, GitCommandRunner } from "../src/index.js";

let root: string;

class FakeGitRunner implements GitCommandRunner {
  public constructor(
    private readonly responses: Readonly<Record<string, GitCommandResult | Error>>,
  ) {}

  public async run(_cwd: string, args: readonly string[]): Promise<GitCommandResult> {
    const response = this.responses[args.join(" ")];
    if (response === undefined) throw new Error(`Brak odpowiedzi dla ${args.join(" ")}`);
    if (response instanceof Error) throw response;
    return response;
  }
}

function result(stdout: string): GitCommandResult {
  return { stdout, stderr: "" };
}

function repositoryRunner(status: string): FakeGitRunner {
  return new FakeGitRunner({
    "rev-parse --show-toplevel": result(`${root}\n`),
    "status --porcelain=v1 --branch": result(status),
    "branch --show-current": result("main\n"),
    "rev-parse HEAD": result("0123456789abcdef\n"),
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workspace-git-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("status Git", () => {
  it("obsługuje katalog niebędący repozytorium", async () => {
    const runner = new FakeGitRunner({
      "rev-parse --show-toplevel": new Error("not a git repository"),
    });
    await expect(readGitStatus(root, runner)).resolves.toEqual({ isRepository: false });
  });

  it("rozpoznaje czyste repozytorium", async () => {
    const status = await readGitStatus(root, repositoryRunner("## main\n"));
    expect(status).toMatchObject({ isRepository: true, branch: "main", clean: true, files: [] });
  });

  it("rozpoznaje repozytorium przed pierwszym commitem", async () => {
    const unborn = Object.assign(new Error("fatal: ambiguous argument 'HEAD': unknown revision"), {
      code: 128,
    });
    const runner = new FakeGitRunner({
      "rev-parse --show-toplevel": result(`${root}\n`),
      "status --porcelain=v1 --branch": result("## No commits yet on main\n?? a.ts\n"),
      "branch --show-current": result("main\n"),
      "rev-parse HEAD": unborn,
    });

    await expect(readGitStatus(root, runner)).resolves.toMatchObject({
      isRepository: true,
      branch: "main",
      clean: false,
      files: [{ path: "a.ts", indexStatus: "?", workingTreeStatus: "?" }],
    });
  });

  it("parsuje zmodyfikowany plik", async () => {
    const status = await readGitStatus(root, repositoryRunner("## main\n M src/index.ts\n"));
    expect(status.files).toContainEqual({
      path: "src/index.ts",
      indexStatus: " ",
      workingTreeStatus: "M",
    });
  });

  it("parsuje nowy nieśledzony plik", async () => {
    const status = await readGitStatus(root, repositoryRunner("## main\n?? src/new.ts\n"));
    expect(status.files).toContainEqual({
      path: "src/new.ts",
      indexStatus: "?",
      workingTreeStatus: "?",
    });
  });

  it("parsuje ahead i behind", async () => {
    const status = await readGitStatus(
      root,
      repositoryRunner("## main...origin/main [ahead 2, behind 1]\n"),
    );
    expect(status).toMatchObject({ ahead: 2, behind: 1 });
  });

  it("zgłasza brak programu Git", async () => {
    const missing = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    const runner = new FakeGitRunner({ "rev-parse --show-toplevel": missing });
    await expect(readGitStatus(root, runner)).rejects.toBeInstanceOf(GitNotAvailableError);
  });

  it("zgłasza timeout procesu Git", async () => {
    const timeout = Object.assign(new Error("timed out"), { killed: true });
    const runner = new FakeGitRunner({ "rev-parse --show-toplevel": timeout });
    await expect(readGitStatus(root, runner)).rejects.toBeInstanceOf(GitTimeoutError);
  });

  it("odrzuca polecenie spoza zamkniętej listy", async () => {
    const runner = new DefaultGitCommandRunner();
    await expect(runner.run(root, ["status", "--short"])).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
  });
});

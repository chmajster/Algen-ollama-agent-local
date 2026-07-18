import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";

import { GitNotAvailableError, GitTimeoutError, WorkspaceAccessError } from "./errors.js";
import type {
  GitCommandResult,
  GitCommandRunner,
  GitStatusFile,
  GitStatusResult,
} from "./workspaceTypes.js";

const ALLOWED_COMMANDS = new Set([
  "rev-parse\0--show-toplevel",
  "status\0--porcelain=v1\0--branch",
  "branch\0--show-current",
  "rev-parse\0HEAD",
]);

function commandKey(args: readonly string[]): string {
  return args.join("\0");
}

export class DefaultGitCommandRunner implements GitCommandRunner {
  public async run(cwd: string, args: readonly string[]): Promise<GitCommandResult> {
    if (!ALLOWED_COMMANDS.has(commandKey(args))) {
      throw new WorkspaceAccessError("Niedozwolone polecenie Git zostało zablokowane.");
    }

    return new Promise<GitCommandResult>((resolvePromise, reject) => {
      execFile(
        "git",
        [...args],
        {
          cwd,
          encoding: "utf8",
          maxBuffer: 256 * 1024,
          timeout: 3_000,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(error);
            return;
          }
          resolvePromise({ stdout, stderr });
        },
      );
    });
  }
}

function errorProperty(error: unknown, property: string): unknown {
  return typeof error === "object" && error !== null && property in error
    ? error[property as keyof typeof error]
    : undefined;
}

function mapGitError(error: unknown): never {
  if (errorProperty(error, "code") === "ENOENT") {
    throw new GitNotAvailableError({ cause: error });
  }
  if (
    errorProperty(error, "killed") === true ||
    errorProperty(error, "code") === "ETIMEDOUT" ||
    errorProperty(error, "signal") === "SIGTERM"
  ) {
    throw new GitTimeoutError({ cause: error });
  }
  throw error;
}

function pathsEqual(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === "";
}

function isUnbornHead(error: unknown): boolean {
  const stderr = errorProperty(error, "stderr");
  const message = errorProperty(error, "message");
  const details = typeof stderr === "string" ? stderr : message;
  return (
    errorProperty(error, "code") === 128 &&
    typeof details === "string" &&
    /ambiguous argument ['"]?HEAD|unknown revision/iu.test(details)
  );
}

function parseStatusFile(line: string): GitStatusFile | undefined {
  if (line.length < 4) {
    return undefined;
  }
  const rawPath = line.slice(3).trim();
  const renamedPath = rawPath.includes(" -> ")
    ? (rawPath.split(" -> ").at(-1) ?? rawPath)
    : rawPath;
  const normalizedPath = renamedPath.replaceAll("\\", "/").replace(/^"|"$/gu, "");
  if (normalizedPath === "" || normalizedPath.startsWith("../") || normalizedPath.startsWith("/")) {
    return undefined;
  }
  return {
    path: normalizedPath,
    indexStatus: line[0] ?? " ",
    workingTreeStatus: line[1] ?? " ",
  };
}

function parseAheadBehind(branchLine: string | undefined): { ahead: number; behind: number } {
  const ahead = branchLine?.match(/ahead (\d+)/u)?.[1];
  const behind = branchLine?.match(/behind (\d+)/u)?.[1];
  return {
    ahead: ahead === undefined ? 0 : Number(ahead),
    behind: behind === undefined ? 0 : Number(behind),
  };
}

export async function readGitStatus(
  workspaceRoot: string,
  runner: GitCommandRunner,
): Promise<GitStatusResult> {
  let gitRoot: string;
  try {
    gitRoot = (await runner.run(workspaceRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
  } catch (error: unknown) {
    try {
      mapGitError(error);
    } catch (mapped: unknown) {
      if (mapped instanceof GitNotAvailableError || mapped instanceof GitTimeoutError) {
        throw mapped;
      }
    }
    return { isRepository: false };
  }

  if (gitRoot === "" || !pathsEqual(workspaceRoot, gitRoot)) {
    return { isRepository: false };
  }

  try {
    const [statusResult, branchResult] = await Promise.all([
      runner.run(workspaceRoot, ["status", "--porcelain=v1", "--branch"]),
      runner.run(workspaceRoot, ["branch", "--show-current"]),
    ]);
    let head: string | undefined;
    try {
      head = (await runner.run(workspaceRoot, ["rev-parse", "HEAD"])).stdout.trim();
    } catch (error: unknown) {
      if (!isUnbornHead(error)) mapGitError(error);
    }
    const statusLines = statusResult.stdout.split(/\r?\n/u).filter((line) => line !== "");
    const branchLine = statusLines.find((line) => line.startsWith("## "));
    const files = statusLines
      .filter((line) => !line.startsWith("## "))
      .map(parseStatusFile)
      .filter((file): file is GitStatusFile => file !== undefined);
    const branch = branchResult.stdout.trim();
    const { ahead, behind } = parseAheadBehind(branchLine);
    return {
      isRepository: true,
      root: workspaceRoot,
      ...(branch === "" ? {} : { branch }),
      ...(head === undefined || head === "" ? {} : { head }),
      detachedHead: branch === "",
      clean: files.length === 0,
      ahead,
      behind,
      files,
    };
  } catch (error: unknown) {
    mapGitError(error);
  }
}

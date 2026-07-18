import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { RemoteApprovalService } from "@local-code-agent/remote-repository";
import {
  PullRequestCreateError,
  RemoteBranchAlreadyPublishedError,
  RemoteBranchDivergedError,
  RemoteBranchProtectedError,
  RemotePushFailedError,
  assertRemoteUrlSafe,
  parseRepositoryReference,
  type PublishBranchInput,
  type PublishBranchResult,
  type RepositoryReference,
} from "@local-code-agent/remote-repository";

import type { GitHubTaskManifest } from "./githubTypes.js";

const execute = promisify(execFile);
const TASK_ID = /^task-[A-Za-z0-9][A-Za-z0-9._-]{2,100}$/;
const BLOCKED_BRANCHES = new Set(["main", "master", "develop"]);

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function git(
  cwd: string,
  args: readonly string[],
  options: { timeoutMs?: number; allowFailure?: boolean } = {},
): Promise<GitResult> {
  try {
    const result = await execute("git", [...args], {
      cwd,
      windowsHide: true,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 2_000_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error: unknown) {
    const exitCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "number"
        ? error.code
        : 1;
    if (options.allowFailure === true) return { stdout: "", stderr: "", exitCode };
    throw new RemotePushFailedError("Kontrolowana operacja Git nie powiodła się.", {
      cause: error,
    });
  }
}

function repositoryKey(reference: RepositoryReference): string {
  return `${reference.host}/${reference.owner}/${reference.repository}`;
}

function assertBranch(branch: string): void {
  if (BLOCKED_BRANCHES.has(branch.toLowerCase()))
    throw new RemoteBranchProtectedError(`Gałąź ${branch} jest zablokowana.`);
  if (
    !/^(?:agent|task)\/[A-Za-z0-9._/-]{1,180}$/.test(branch) ||
    branch.includes("..") ||
    branch.endsWith("/")
  ) {
    throw new RemoteBranchProtectedError(
      "Publikować można wyłącznie poprawną gałąź agent/ lub task/.",
    );
  }
}

export async function loadTaskManifest(
  workspaceRoot: string,
  taskId: string,
): Promise<GitHubTaskManifest> {
  if (!TASK_ID.test(taskId))
    throw new PullRequestCreateError("Identyfikator zadania jest niepoprawny.");
  const path = join(resolve(workspaceRoot), ".agent", "tasks", taskId, "manifest.json");
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null)
    throw new PullRequestCreateError("Manifest zadania jest niepoprawny.");
  const manifest = parsed as GitHubTaskManifest;
  if (manifest.id !== taskId || manifest.status !== "completed")
    throw new PullRequestCreateError("Publikować można wyłącznie ukończone zadanie.");
  if (manifest.finalReview?.completed !== true)
    throw new PullRequestCreateError("Zadanie nie ma końcowego review.");
  if (!Array.isArray(manifest.commits) || manifest.commits.length === 0)
    throw new PullRequestCreateError("Zadanie nie ma lokalnych commitów.");
  assertBranch(manifest.branch);
  return manifest;
}

export async function saveTaskManifest(
  workspaceRoot: string,
  manifest: GitHubTaskManifest,
): Promise<void> {
  if (!TASK_ID.test(manifest.id))
    throw new PullRequestCreateError("Identyfikator zadania jest niepoprawny.");
  const path = join(resolve(workspaceRoot), ".agent", "tasks", manifest.id, "manifest.json");
  const temporary = `${path}.remote.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export class GitHubBranchPublisher {
  public constructor(
    private readonly approvals: RemoteApprovalService,
    private readonly timeoutMs = 60_000,
  ) {}

  public async publish(input: PublishBranchInput): Promise<PublishBranchResult> {
    assertBranch(input.branch);
    const currentBranch = (
      await git(input.workspacePath, ["branch", "--show-current"])
    ).stdout.trim();
    if (currentBranch !== input.branch)
      throw new RemoteBranchProtectedError("Aktywna gałąź nie jest gałęzią zadania.");
    const localHead = (await git(input.workspacePath, ["rev-parse", "HEAD"])).stdout.trim();
    if (localHead !== input.localHead || !/^[0-9a-f]{40}$/i.test(localHead)) {
      throw new RemoteBranchDivergedError("Lokalny HEAD zmienił się od przygotowania operacji.");
    }
    const status = (
      await git(input.workspacePath, ["status", "--porcelain=v1", "--untracked-files=normal"])
    ).stdout;
    if (status.trim() !== "")
      throw new RemotePushFailedError("Worktree zawiera niezatwierdzone zmiany.");

    const remoteUrl = (
      await git(input.workspacePath, ["remote", "get-url", input.repository.remoteName])
    ).stdout.trim();
    assertRemoteUrlSafe(remoteUrl);
    const actualReference = parseRepositoryReference(
      { name: input.repository.remoteName, url: remoteUrl },
      {
        expectedHost: input.repository.host,
        allowEnterprise: input.repository.host !== "github.com",
      },
    );
    if (
      repositoryKey(actualReference).toLowerCase() !== repositoryKey(input.repository).toLowerCase()
    ) {
      throw new RemotePushFailedError("Remote zmienił repozytorium od czasu weryfikacji.");
    }

    const ref = `refs/heads/${input.branch}`;
    const remoteHead = await this.remoteHead(input.workspacePath, input.repository.remoteName, ref);
    if (remoteHead === localHead) {
      throw new RemoteBranchAlreadyPublishedError("Zdalna gałąź wskazuje już lokalny HEAD.");
    }
    if (remoteHead !== undefined) {
      if (input.expectedRemoteHead === undefined || input.expectedRemoteHead !== remoteHead) {
        throw new RemoteBranchDivergedError("Zdalny HEAD różni się od zatwierdzonego stanu.");
      }
      const ancestry = await git(
        input.workspacePath,
        ["merge-base", "--is-ancestor", remoteHead, localHead],
        { allowFailure: true },
      );
      if (ancestry.exitCode !== 0)
        throw new RemoteBranchDivergedError("Push nie jest fast-forward.");
    }

    this.approvals.consume(input.approvalId, "publish_branch", repositoryKey(input.repository));
    await git(input.workspacePath, ["push", input.repository.remoteName, `${ref}:${ref}`], {
      timeoutMs: this.timeoutMs,
    });
    const verifiedHead = await this.remoteHead(
      input.workspacePath,
      input.repository.remoteName,
      ref,
    );
    if (verifiedHead !== localHead)
      throw new RemotePushFailedError("Nie udało się zweryfikować zdalnego commita po push.");
    return {
      branch: input.branch,
      remoteName: input.repository.remoteName,
      localHead,
      remoteHead: verifiedHead,
      publishedAt: new Date().toISOString(),
      created: remoteHead === undefined,
    };
  }

  private async remoteHead(
    cwd: string,
    remoteName: string,
    ref: string,
  ): Promise<string | undefined> {
    const output = (
      await git(cwd, ["ls-remote", "--heads", remoteName, ref], { timeoutMs: this.timeoutMs })
    ).stdout.trim();
    if (output === "") return undefined;
    const sha = output.split(/\s+/)[0];
    if (sha === undefined || !/^[0-9a-f]{40}$/i.test(sha))
      throw new RemotePushFailedError("Remote zwrócił niepoprawny commit.");
    return sha;
  }
}

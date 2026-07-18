import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  resolveRepositoryReference,
  type RemoteDescriptor,
  type RepositoryReference,
} from "@local-code-agent/remote-repository";

const execute = promisify(execFile);

export async function readGitRemotes(workspacePath: string): Promise<RemoteDescriptor[]> {
  const { stdout } = await execute("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], {
    cwd: workspacePath,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 256_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).catch((error: unknown) => {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === 1) return { stdout: "", stderr: "" };
    throw error;
  });
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.search(/\s/);
      const key = line.slice(0, separator);
      return {
        name: key.slice("remote.".length, -".url".length),
        url: line.slice(separator).trim(),
      };
    });
}

export class GitHubRepositoryResolver {
  public constructor(
    private readonly options: { expectedHost: string; allowEnterprise: boolean },
  ) {}

  public async resolve(
    workspacePath: string,
    selectedRemote?: string,
  ): Promise<RepositoryReference> {
    const remotes = await readGitRemotes(workspacePath);
    return resolveRepositoryReference(remotes, {
      expectedHost: this.options.expectedHost,
      allowEnterprise: this.options.allowEnterprise,
      ...(selectedRemote === undefined ? {} : { selectedRemote }),
    });
  }
}

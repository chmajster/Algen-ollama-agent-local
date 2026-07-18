import { sanitizeCiLog } from "@local-code-agent/ci-analysis";
import {
  CheckLogUnavailableError,
  CheckRunNotFoundError,
  type CheckLogResult,
  type CheckReference,
} from "@local-code-agent/remote-repository";

import type { GitHubApiClient, GitHubProviderConfig } from "./githubTypes.js";

export class GitHubActionsLogService {
  public constructor(
    private readonly client: GitHubApiClient,
    private readonly config: GitHubProviderConfig,
  ) {}

  public async get(reference: CheckReference): Promise<CheckLogResult> {
    const id = Number(reference.checkId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new CheckRunNotFoundError();
    try {
      const response = await this.client.request<unknown>(
        "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
        {
          owner: reference.repository.owner,
          repo: reference.repository.repository,
          job_id: id,
          mediaType: { format: "raw" },
        },
      );
      const raw =
        typeof response.data === "string"
          ? response.data
          : response.data instanceof ArrayBuffer
            ? new TextDecoder().decode(response.data)
            : JSON.stringify(response.data);
      const sanitized = sanitizeCiLog(raw, this.config.maxCiLogChars);
      return {
        checkId: reference.checkId,
        content: sanitized.content,
        truncated: sanitized.truncated,
        redactions: sanitized.redactions,
        errorBlocks: sanitized.errorBlocks,
        ...(sanitized.promptInjectionWarning ? { promptInjectionWarning: true } : {}),
      };
    } catch (error: unknown) {
      if (error instanceof CheckRunNotFoundError) throw error;
      throw new CheckLogUnavailableError(undefined, { cause: error });
    }
  }
}

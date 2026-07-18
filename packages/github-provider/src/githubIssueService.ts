import {
  PullRequestCreateError,
  type RepositoryReference,
} from "@local-code-agent/remote-repository";

import type { GitHubApiClient } from "./githubTypes.js";

export class GitHubIssueService {
  private readonly labelCache = new Map<string, { labels: Set<string>; expiresAt: number }>();

  public constructor(private readonly client: GitHubApiClient) {}

  public async assertIssueExists(
    reference: RepositoryReference,
    issueNumber: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
      throw new PullRequestCreateError("Numer issue jest niepoprawny.");
    await this.client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      owner: reference.owner,
      repo: reference.repository,
      issue_number: issueNumber,
    });
  }

  public async assertLabelsExist(
    reference: RepositoryReference,
    labels: readonly string[],
  ): Promise<void> {
    if (labels.length === 0) return;
    const key = `${reference.host}/${reference.owner}/${reference.repository}`.toLowerCase();
    let cached = this.labelCache.get(key);
    if (cached === undefined || cached.expiresAt <= Date.now()) {
      const { data } = await this.client.request<Array<{ name: string }>>(
        "GET /repos/{owner}/{repo}/labels",
        {
          owner: reference.owner,
          repo: reference.repository,
          per_page: 100,
        },
      );
      cached = {
        labels: new Set(data.map((label) => label.name.toLowerCase())),
        expiresAt: Date.now() + 60_000,
      };
      this.labelCache.set(key, cached);
    }
    const existing = cached.labels;
    const missing = labels.filter((label) => !existing.has(label.toLowerCase()));
    if (missing.length > 0)
      throw new PullRequestCreateError(`Etykiety nie istnieją: ${missing.join(", ")}.`);
  }
}

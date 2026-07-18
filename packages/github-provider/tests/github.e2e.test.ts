import { describe, expect, it } from "vitest";

import { DEFAULT_GITHUB_CONFIG, GitHubAuthentication, OctokitGitHubClient } from "../src/index.js";

const enabled = process.env.GITHUB_E2E === "true";

describe.skipIf(!enabled)("GitHub opt-in E2E", () => {
  it("reads only the explicitly configured repository", async () => {
    const repository = process.env.GITHUB_E2E_REPOSITORY;
    if (repository === undefined || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
      throw new Error("GITHUB_E2E_REPOSITORY=owner/repository is required.");
    }
    const authentication = new GitHubAuthentication();
    await authentication.connectFromEnvironment(process.env);
    const client = new OctokitGitHubClient(authentication.getToken(), {
      ...DEFAULT_GITHUB_CONFIG,
      enabled: true,
      authMode: "token",
    });
    const [owner, repo] = repository.split("/");
    const result = await client.request<{ full_name: string }>("GET /repos/{owner}/{repo}", {
      owner,
      repo,
    });
    expect(result.data.full_name.toLowerCase()).toBe(repository.toLowerCase());
  });
});

import type {
  RepositoryPermissions,
  RepositoryReference,
} from "@local-code-agent/remote-repository";

import type { GitHubApiClient } from "./githubTypes.js";

interface RepositoryPermissionResponse {
  permissions?: {
    pull?: boolean;
    triage?: boolean;
    push?: boolean;
    maintain?: boolean;
    admin?: boolean;
  };
  role_name?: string;
}

export class GitHubPermissionService {
  public constructor(private readonly client: GitHubApiClient) {}

  public async get(reference: RepositoryReference): Promise<RepositoryPermissions> {
    const { data } = await this.client.request<RepositoryPermissionResponse>(
      "GET /repos/{owner}/{repo}",
      {
        owner: reference.owner,
        repo: reference.repository,
      },
    );
    const role = data.role_name ?? "none";
    const admin = data.permissions?.admin === true || role === "admin";
    const maintain =
      admin || data.permissions?.maintain === true || ["maintain", "admin"].includes(role);
    const write =
      maintain || data.permissions?.push === true || ["write", "maintain", "admin"].includes(role);
    const triage =
      write ||
      data.permissions?.triage === true ||
      ["triage", "write", "maintain", "admin"].includes(role);
    const read =
      triage ||
      data.permissions?.pull === true ||
      ["read", "triage", "write", "maintain", "admin"].includes(role);
    return {
      read,
      triage,
      write,
      maintain,
      admin,
      canPush: write,
      canCreatePullRequest: write,
      canComment: triage || write,
      canManageIssues: triage || write,
      canResolveReviewThreads: write,
    };
  }
}

import type {
  CheckRunSummary,
  PullRequest,
  RepositoryPermissions,
  RepositoryReference,
  ReviewThread,
} from "@local-code-agent/remote-repository";

export interface GitHubProviderConfig {
  enabled: boolean;
  authMode: "vscode" | "token";
  apiBaseUrl: string;
  webBaseUrl: string;
  allowEnterprise: boolean;
  allowForkPublish: boolean;
  createDraftPullRequest: boolean;
  requirePushConfirmation: boolean;
  requirePullRequestConfirmation: boolean;
  requireCommentConfirmation: boolean;
  requireResolveThreadConfirmation: boolean;
  allowLabelChanges: boolean;
  allowAssigneeChanges: boolean;
  allowMilestoneChanges: boolean;
  allowIssueCreation: boolean;
  allowIssueClosing: boolean;
  allowReadyForReview: boolean;
  allowMerge: false;
  allowBranchDelete: false;
  allowForcePush: false;
  maxPrBodyChars: number;
  maxReviewComments: number;
  maxCiLogChars: number;
  maxApiRequestsPerSession: number;
  requestTimeoutMs: number;
  ciPollIntervalMs: number;
  ciMaxWaitMs: number;
}

export const DEFAULT_GITHUB_CONFIG: GitHubProviderConfig = {
  enabled: false,
  authMode: "vscode",
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  allowEnterprise: false,
  allowForkPublish: false,
  createDraftPullRequest: true,
  requirePushConfirmation: true,
  requirePullRequestConfirmation: true,
  requireCommentConfirmation: true,
  requireResolveThreadConfirmation: true,
  allowLabelChanges: true,
  allowAssigneeChanges: false,
  allowMilestoneChanges: false,
  allowIssueCreation: false,
  allowIssueClosing: false,
  allowReadyForReview: false,
  allowMerge: false,
  allowBranchDelete: false,
  allowForcePush: false,
  maxPrBodyChars: 50_000,
  maxReviewComments: 200,
  maxCiLogChars: 200_000,
  maxApiRequestsPerSession: 200,
  requestTimeoutMs: 60_000,
  ciPollIntervalMs: 30_000,
  ciMaxWaitMs: 1_800_000,
};

export interface GitHubRepositoryReference extends RepositoryReference {
  provider: "github";
}

export interface GitHubApiResponse<T> {
  data: T;
  status: number;
  headers: Record<string, string | number | undefined>;
}

export interface GitHubApiClient {
  request<T>(route: string, parameters?: Record<string, unknown>): Promise<GitHubApiResponse<T>>;
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  getRequestCount(): number;
}

export interface PullRequestBodyInput {
  goal: string;
  changes: string[];
  changedAreas: string[];
  verification: Array<{
    name: string;
    status: "passed" | "failed" | "unavailable";
    details?: string;
  }>;
  risks: string[];
  taskId: string;
  commits: number;
  issueNumber?: number;
  issueLinkKeyword?: "Closes" | "Fixes" | "Refs";
}

export interface GitHubRemoteStatus {
  enabled: boolean;
  authenticated: boolean;
  repository?: RepositoryReference;
  verified: boolean;
  permissions?: RepositoryPermissions;
  pullRequest?: PullRequest;
  checks?: CheckRunSummary[];
  reviewThreads?: ReviewThread[];
  warnings: string[];
}

export interface GitHubPerformanceMetrics {
  authenticationMs?: number;
  repositoryVerificationMs?: number;
  branchPublishMs?: number;
  pullRequestCreateMs?: number;
  checksReadMs?: number;
  logsReadMs?: number;
  reviewReadMs?: number;
}

export interface GitHubTaskManifest {
  id: string;
  branch: string;
  baseBranch: string;
  workspacePath: string;
  status: "completed" | "failed" | "cancelled";
  finalReview: { completed: boolean; summary?: string };
  commits: Array<{ sha: string; subject: string }>;
  verification?: PullRequestBodyInput["verification"];
  changedFiles?: string[];
  goal?: string;
  remote?: {
    provider: "github";
    repository: { host: string; owner: string; name: string; remoteName: string };
    publishedBranch?: { name: string; remoteHead: string; publishedAt: string };
    pullRequest?: {
      number: number;
      url: string;
      state: "open" | "closed";
      draft: boolean;
      headSha: string;
      baseBranch: string;
      createdAt: string;
      updatedAt: string;
    };
    ci?: { lastCheckedAt?: string; status?: string; failedChecks?: number };
  };
}

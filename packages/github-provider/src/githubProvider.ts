import type { RemoteAuditService } from "@local-code-agent/remote-repository";
import {
  RemoteApprovalService,
  RemoteBranchProtectedError,
  RemoteIntegrationDisabledError,
  RemoteOperationPolicy,
  RemotePermissionDeniedError,
  RemoteRepositoryUnverifiedError,
  type CheckLogResult,
  type CheckReference,
  type CheckRunSummary,
  type CreatePullRequestInput,
  type GitHubRateLimitState,
  type PublishBranchInput,
  type PublishBranchResult,
  type PullRequest,
  type PullRequestReference,
  type PullRequestConversationComment,
  type PullRequestReviewSummary,
  type RemoteBranch,
  type RemoteOperationAction,
  type RemoteRepository,
  type RemoteRepositoryProvider,
  type RemoteStatistics,
  type RemoteUser,
  type RepositoryPermissions,
  type RepositoryReference,
  type RepositoryTrustState,
  type ResolveReviewThreadInput,
  type ReviewComment,
  type ReviewThread,
  type ReplyToReviewThreadInput,
  type UpdatePullRequestInput,
} from "@local-code-agent/remote-repository";

import { GitHubActionsLogService } from "./githubActionsLogService.js";
import type { GitHubAuthentication } from "./githubAuthentication.js";
import { GitHubBranchPublisher } from "./githubBranchPublisher.js";
import { GitHubChecksService } from "./githubChecksService.js";
import { OctokitGitHubClient } from "./githubClient.js";
import { GitHubPermissionService } from "./githubPermissionService.js";
import { GitHubIssueService } from "./githubIssueService.js";
import { GitHubPullRequestService } from "./githubPullRequestService.js";
import { GitHubRateLimitService } from "./githubRateLimitService.js";
import { GitHubReviewService } from "./githubReviewService.js";
import type {
  GitHubApiClient,
  GitHubPerformanceMetrics,
  GitHubProviderConfig,
} from "./githubTypes.js";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

function repositoryKey(reference: RepositoryReference): string {
  return `${reference.host}/${reference.owner}/${reference.repository}`.toLowerCase();
}

function emptyStatistics(): RemoteStatistics {
  return {
    remoteApiRequests: 0,
    remoteApiFailures: 0,
    remoteRateLimitWarnings: 0,
    branchesPublished: 0,
    branchPublishFailures: 0,
    pullRequestsCreated: 0,
    pullRequestsUpdated: 0,
    ciChecksRead: 0,
    ciChecksFailed: 0,
    ciLogsRead: 0,
    ciFailuresAnalyzed: 0,
    reviewThreadsRead: 0,
    actionableReviewThreads: 0,
    reviewRepliesSent: 0,
    reviewThreadsResolved: 0,
    remoteApprovalsRequested: 0,
    remoteApprovalsGranted: 0,
    remoteApprovalsDenied: 0,
    remotePromptInjectionWarnings: 0,
  };
}

export interface GitHubProviderOptions {
  config: GitHubProviderConfig;
  authentication: GitHubAuthentication;
  client?: GitHubApiClient;
  approvals?: RemoteApprovalService;
  audit?: RemoteAuditService;
  sessionId?: string;
  branchPublisher?: GitHubBranchPublisher;
}

export class GitHubProvider implements RemoteRepositoryProvider {
  public readonly name = "github" as const;
  private readonly client: GitHubApiClient;
  private readonly approvals: RemoteApprovalService;
  private readonly policy = new RemoteOperationPolicy();
  private readonly permissionsService: GitHubPermissionService;
  private readonly branchPublisher: GitHubBranchPublisher;
  private readonly pullRequests: GitHubPullRequestService;
  private readonly issues: GitHubIssueService;
  private readonly rateLimit: GitHubRateLimitService;
  private readonly checks: GitHubChecksService;
  private readonly logs: GitHubActionsLogService;
  private readonly reviews: GitHubReviewService;
  private readonly trusts = new Map<string, RepositoryTrustState>();
  private readonly repositoryCache = new Map<string, CacheEntry<RemoteRepository>>();
  private readonly permissionCache = new Map<string, CacheEntry<RepositoryPermissions>>();
  private userCache: CacheEntry<RemoteUser> | undefined;
  private readonly statistics = emptyStatistics();
  private readonly performance: GitHubPerformanceMetrics = {};

  public constructor(private readonly options: GitHubProviderOptions) {
    this.ensureEnabled();
    this.client =
      options.client ?? new OctokitGitHubClient(options.authentication.getToken(), options.config);
    this.approvals = options.approvals ?? new RemoteApprovalService();
    this.permissionsService = new GitHubPermissionService(this.client);
    this.branchPublisher =
      options.branchPublisher ??
      new GitHubBranchPublisher(this.approvals, options.config.requestTimeoutMs);
    this.pullRequests = new GitHubPullRequestService(this.client, this.approvals, options.config);
    this.issues = new GitHubIssueService(this.client);
    this.rateLimit = new GitHubRateLimitService(this.client);
    this.checks = new GitHubChecksService(
      this.client,
      this.rateLimit,
      options.config,
      this.pullRequests,
    );
    this.logs = new GitHubActionsLogService(this.client, options.config);
    this.reviews = new GitHubReviewService(this.client, this.approvals, options.config);
  }

  private ensureEnabled(): void {
    if (!this.options.config.enabled) throw new RemoteIntegrationDisabledError();
  }

  private ensureVerified(reference: RepositoryReference): void {
    const trust = this.trusts.get(repositoryKey(reference));
    if (trust !== "verified_for_session" && trust !== "verified_for_workspace") {
      throw new RemoteRepositoryUnverifiedError();
    }
  }

  private async permission(reference: RepositoryReference): Promise<RepositoryPermissions> {
    const key = repositoryKey(reference);
    const cached = this.permissionCache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.permissionsService.get(reference);
    this.permissionCache.set(key, { value, expiresAt: Date.now() + 60_000 });
    return value;
  }

  private async authorize(
    reference: RepositoryReference,
    action: Parameters<RemoteOperationPolicy["evaluate"]>[0]["action"],
  ): Promise<void> {
    this.policy.evaluate({
      action,
      trust: this.trusts.get(repositoryKey(reference)) ?? "unverified",
      permissions: await this.permission(reference),
    });
  }

  public async prepareApproval(
    action: Exclude<
      Parameters<RemoteOperationPolicy["evaluate"]>[0]["action"],
      | "read_repository"
      | "read_checks"
      | "read_logs"
      | "read_reviews"
      | "force_push"
      | "merge_pull_request"
      | "delete_remote_branch"
    >,
    reference: RepositoryReference,
    summary: string,
    taskId?: string,
  ): Promise<string> {
    await this.authorize(reference, action);
    this.statistics.remoteApprovalsRequested += 1;
    const request = this.approvals.request({
      action,
      repository: repositoryKey(reference),
      summary,
      ...(taskId === undefined ? {} : { taskId }),
    });
    return request.id;
  }

  public decideApproval(
    id: string,
    decision: "approved" | "denied",
    actor: "user_cli" | "user_ui",
  ): void {
    this.approvals.decide(id, decision, actor);
    if (decision === "approved") this.statistics.remoteApprovalsGranted += 1;
    else this.statistics.remoteApprovalsDenied += 1;
  }

  public async verifyRepository(
    reference: RepositoryReference,
    trust: Extract<
      RepositoryTrustState,
      "verified_for_session" | "verified_for_workspace"
    > = "verified_for_session",
  ): Promise<{
    repository: RemoteRepository;
    user: RemoteUser;
    permissions: RepositoryPermissions;
  }> {
    const startedAt = Date.now();
    try {
      const [repository, user, permissions] = await Promise.all([
        this.fetchRepository(reference),
        this.getAuthenticatedUser(),
        this.permission(reference),
      ]);
      this.trusts.set(repositoryKey(reference), trust);
      this.performance.repositoryVerificationMs = Date.now() - startedAt;
      await this.audit("verify_repository", "not_required", "success", reference, {
        durationMs: Date.now() - startedAt,
      });
      return { repository, user, permissions };
    } catch (error: unknown) {
      const errorCode = this.errorCode(error);
      await this.audit("verify_repository", "not_required", "failed", reference, {
        durationMs: Date.now() - startedAt,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
      throw error;
    }
  }

  public async getAuthenticatedUser(): Promise<RemoteUser> {
    if (this.userCache !== undefined && this.userCache.expiresAt > Date.now())
      return this.userCache.value;
    const startedAt = Date.now();
    const { data } = await this.client.request<{
      id: number;
      login: string;
      name?: string | null;
      avatar_url?: string;
    }>("GET /user");
    const value: RemoteUser = {
      id: String(data.id),
      login: data.login,
      ...(data.name == null ? {} : { name: data.name }),
      ...(data.avatar_url === undefined ? {} : { avatarUrl: data.avatar_url }),
    };
    this.userCache = { value, expiresAt: Date.now() + 60_000 };
    this.performance.authenticationMs = Date.now() - startedAt;
    return value;
  }

  public async getRepository(reference: RepositoryReference): Promise<RemoteRepository> {
    return this.fetchRepository(reference);
  }

  private async fetchRepository(reference: RepositoryReference): Promise<RemoteRepository> {
    const key = repositoryKey(reference);
    const cached = this.repositoryCache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    const { data } = await this.client.request<{
      id: number;
      default_branch: string;
      private: boolean;
      fork: boolean;
      html_url: string;
    }>("GET /repos/{owner}/{repo}", { owner: reference.owner, repo: reference.repository });
    const value: RemoteRepository = {
      id: String(data.id),
      reference,
      defaultBranch: data.default_branch,
      private: data.private,
      fork: data.fork,
      webUrl: data.html_url,
    };
    this.repositoryCache.set(key, { value, expiresAt: Date.now() + 60_000 });
    return value;
  }

  public async getRepositoryPermissions(
    reference: RepositoryReference,
  ): Promise<RepositoryPermissions> {
    return this.permission(reference);
  }

  public async listBranches(reference: RepositoryReference): Promise<RemoteBranch[]> {
    this.ensureVerified(reference);
    const { data } = await this.client.request<
      Array<{ name: string; protected: boolean; commit: { sha: string } }>
    >("GET /repos/{owner}/{repo}/branches", {
      owner: reference.owner,
      repo: reference.repository,
      per_page: 100,
    });
    return data.map((branch) => ({
      name: branch.name,
      protected: branch.protected,
      commitSha: branch.commit.sha,
    }));
  }

  public async publishBranch(input: PublishBranchInput): Promise<PublishBranchResult> {
    const startedAt = Date.now();
    await this.authorize(input.repository, "publish_branch");
    const repository = await this.fetchRepository(input.repository);
    if (repository.fork && !this.options.config.allowForkPublish) {
      throw new RemotePermissionDeniedError("Publikowanie do forka jest wyłączone.");
    }
    const protectedBranch = (await this.listBranches(input.repository)).find(
      (branch) => branch.name === input.branch && branch.protected,
    );
    if (protectedBranch !== undefined) throw new RemoteBranchProtectedError();
    try {
      const result = await this.branchPublisher.publish(input);
      this.performance.branchPublishMs = Date.now() - startedAt;
      this.statistics.branchesPublished += 1;
      await this.audit("publish_branch", "allowed_once", "success", input.repository, {
        taskId: input.taskId,
        branch: input.branch,
        commitSha: result.remoteHead,
      });
      return result;
    } catch (error: unknown) {
      this.statistics.branchPublishFailures += 1;
      const errorCode = this.errorCode(error);
      await this.audit("publish_branch", "allowed_once", "failed", input.repository, {
        taskId: input.taskId,
        branch: input.branch,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
      throw error;
    }
  }

  public async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    const startedAt = Date.now();
    await this.authorize(input.repository, "create_pull_request");
    const result = await this.pullRequests.create(input);
    this.performance.pullRequestCreateMs = Date.now() - startedAt;
    this.statistics.pullRequestsCreated += 1;
    await this.audit("create_pull_request", "allowed_once", "success", input.repository, {
      taskId: input.taskId,
      pullRequestNumber: result.number,
      commitSha: result.headSha,
    });
    return result;
  }

  public async updatePullRequest(input: UpdatePullRequestInput): Promise<PullRequest> {
    await this.authorize(input.reference.repository, "update_pull_request");
    const result = await this.pullRequests.update(input);
    this.statistics.pullRequestsUpdated += 1;
    await this.audit("update_pull_request", "allowed_once", "success", input.reference.repository, {
      pullRequestNumber: result.number,
    });
    return result;
  }

  public async validateIssue(reference: RepositoryReference, issueNumber: number): Promise<void> {
    this.ensureVerified(reference);
    await this.issues.assertIssueExists(reference, issueNumber);
  }

  public async validateLabels(
    reference: RepositoryReference,
    labels: readonly string[],
  ): Promise<void> {
    this.ensureVerified(reference);
    await this.issues.assertLabelsExist(reference, labels);
  }

  public async getPullRequest(reference: PullRequestReference): Promise<PullRequest> {
    this.ensureVerified(reference.repository);
    return this.pullRequests.get(reference);
  }

  public async listPullRequestChecks(reference: PullRequestReference): Promise<CheckRunSummary[]> {
    const startedAt = Date.now();
    await this.authorize(reference.repository, "read_checks");
    const result = await this.checks.list(reference);
    this.performance.checksReadMs = Date.now() - startedAt;
    this.statistics.ciChecksRead += result.length;
    this.statistics.ciChecksFailed += result.filter(
      (check) => check.conclusion === "failure",
    ).length;
    await this.audit("read_checks", "not_required", "success", reference.repository, {
      pullRequestNumber: reference.number,
    });
    return result;
  }

  public async watchPullRequestChecks(
    reference: PullRequestReference,
    mode: "once" | "until_complete" | "manual",
    signal?: AbortSignal,
    onChange?: (checks: CheckRunSummary[]) => void,
  ): Promise<CheckRunSummary[]> {
    await this.authorize(reference.repository, "read_checks");
    return this.checks.watch(reference, mode, signal, onChange);
  }

  public async getCheckLogs(reference: CheckReference): Promise<CheckLogResult> {
    const startedAt = Date.now();
    await this.authorize(reference.repository, "read_logs");
    const result = await this.logs.get(reference);
    this.performance.logsReadMs = Date.now() - startedAt;
    this.statistics.ciLogsRead += 1;
    if (result.promptInjectionWarning === true) this.statistics.remotePromptInjectionWarnings += 1;
    await this.audit("read_logs", "not_required", "success", reference.repository, {
      pullRequestNumber: reference.number,
    });
    return result;
  }

  public async listReviewThreads(reference: PullRequestReference): Promise<ReviewThread[]> {
    const startedAt = Date.now();
    await this.authorize(reference.repository, "read_reviews");
    const result = await this.reviews.listThreads(reference);
    this.performance.reviewReadMs = Date.now() - startedAt;
    this.statistics.reviewThreadsRead += result.length;
    this.statistics.actionableReviewThreads += result.filter(
      (thread) => thread.classification === "actionable",
    ).length;
    this.statistics.remotePromptInjectionWarnings += result.filter(
      (thread) => thread.securityWarnings?.includes("REMOTE_PROMPT_INJECTION_WARNING") === true,
    ).length;
    await this.audit("read_reviews", "not_required", "success", reference.repository, {
      pullRequestNumber: reference.number,
    });
    return result;
  }

  public async listReviews(reference: PullRequestReference): Promise<{
    reviews: PullRequestReviewSummary[];
    comments: PullRequestConversationComment[];
  }> {
    await this.authorize(reference.repository, "read_reviews");
    const [reviews, comments] = await Promise.all([
      this.reviews.listReviews(reference),
      this.reviews.listConversationComments(reference),
    ]);
    const warnings = [...reviews, ...comments].filter(
      (item) => item.securityWarnings?.includes("REMOTE_PROMPT_INJECTION_WARNING") === true,
    ).length;
    this.statistics.remotePromptInjectionWarnings += warnings;
    return { reviews, comments };
  }

  public async replyToReviewThread(input: ReplyToReviewThreadInput): Promise<ReviewComment> {
    await this.authorize(input.reference.repository, "reply_review");
    const result = await this.reviews.reply(input);
    this.statistics.reviewRepliesSent += 1;
    await this.audit("reply_review", "allowed_once", "success", input.reference.repository, {
      pullRequestNumber: input.reference.number,
      ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }),
    });
    return result;
  }

  public async resolveReviewThread(input: ResolveReviewThreadInput): Promise<void> {
    await this.authorize(input.reference.repository, "resolve_thread");
    await this.reviews.resolve(input);
    this.statistics.reviewThreadsResolved += 1;
    await this.audit("resolve_thread", "allowed_once", "success", input.reference.repository, {
      pullRequestNumber: input.reference.number,
    });
  }

  public async getRateLimit(): Promise<GitHubRateLimitState> {
    return this.rateLimit.get();
  }

  public getStatistics(): RemoteStatistics {
    return { ...this.statistics, remoteApiRequests: this.client.getRequestCount() };
  }

  public getPerformanceMetrics(): GitHubPerformanceMetrics {
    return { ...this.performance };
  }

  public getTrust(reference: RepositoryReference): RepositoryTrustState {
    return this.trusts.get(repositoryKey(reference)) ?? "unverified";
  }

  public disconnect(): void {
    this.options.authentication.disconnect();
    this.trusts.clear();
    this.repositoryCache.clear();
    this.permissionCache.clear();
    this.userCache = undefined;
  }

  private errorCode(error: unknown): string | undefined {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
      ? error.code
      : undefined;
  }

  private async audit(
    action: RemoteOperationAction,
    approval: "not_required" | "allowed_once" | "denied",
    result: "success" | "failed" | "timeout" | "blocked" | "cancelled",
    reference: RepositoryReference,
    extra: {
      taskId?: string;
      branch?: string;
      pullRequestNumber?: number;
      commitSha?: string;
      errorCode?: string;
      durationMs?: number;
    } = {},
  ): Promise<void> {
    if (this.options.audit === undefined) return;
    await this.options.audit.record({
      timestamp: new Date().toISOString(),
      sessionId: this.options.sessionId ?? "remote-session",
      provider: "github",
      repository: repositoryKey(reference),
      action,
      approval,
      result,
      ...extra,
    });
  }
}

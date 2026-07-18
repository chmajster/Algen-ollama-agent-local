import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { CiAnalysisService, type CiFailureAnalysis } from "@local-code-agent/ci-analysis";
import {
  DEFAULT_GITHUB_CONFIG,
  GitHubAuthentication,
  GitHubProvider,
  GitHubRepositoryResolver,
  buildPullRequestBody,
  loadTaskManifest,
  pullRequestMetadataDiff,
  saveTaskManifest,
  validatePullRequestTitle,
  type GitHubProviderConfig,
  type GitHubTaskManifest,
} from "@local-code-agent/github-provider";
import {
  PullRequestCreateError,
  PullRequestNotFoundError,
  RemoteAuditService,
  RemoteAuthenticationRequiredError,
  RemoteIntegrationDisabledError,
  type CheckLogResult,
  type CheckRunSummary,
  type PullRequest,
  type PullRequestReference,
  type RemoteUser,
  type RepositoryPermissions,
  type RepositoryReference,
  type ReviewComment,
  type ReviewThread,
} from "@local-code-agent/remote-repository";

import type { AgentConfig } from "../config.js";

export interface PreparedPublish {
  approvalId: string;
  taskId: string;
  repository: RepositoryReference;
  branch: string;
  commits: number;
  localHead: string;
  expectedRemoteHead?: string;
  workspacePath: string;
}

export interface PreparedPullRequest {
  approvalId: string;
  manifest: GitHubTaskManifest;
  repository: RepositoryReference;
  title: string;
  body: string;
  issueNumber?: number;
  labels?: string[];
}

export interface PreparedPullRequestUpdate {
  approvalId: string;
  manifest: GitHubTaskManifest;
  repository: RepositoryReference;
  reference: PullRequestReference;
  title?: string;
  body?: string;
  labels?: string[];
  diff: string;
}

function providerConfig(config: AgentConfig): GitHubProviderConfig {
  return {
    ...DEFAULT_GITHUB_CONFIG,
    enabled: config.remoteEnabled,
    authMode: config.githubAuthMode,
    apiBaseUrl: config.githubApiBaseUrl,
    webBaseUrl: config.githubWebBaseUrl,
    allowEnterprise: config.githubAllowEnterprise,
    allowForkPublish: config.githubAllowForkPublish,
    createDraftPullRequest: config.githubCreateDraftPr,
    requirePushConfirmation: config.githubRequirePushConfirmation,
    requirePullRequestConfirmation: config.githubRequirePrConfirmation,
    requireCommentConfirmation: config.githubRequireCommentConfirmation,
    requireResolveThreadConfirmation: config.githubRequireResolveThreadConfirmation,
    allowLabelChanges: config.githubAllowLabelChanges,
    allowAssigneeChanges: config.githubAllowAssigneeChanges,
    allowMilestoneChanges: config.githubAllowMilestoneChanges,
    allowIssueCreation: config.githubAllowIssueCreation,
    allowIssueClosing: config.githubAllowIssueClosing,
    allowReadyForReview: config.githubAllowPrReadyForReview,
    allowMerge: config.githubAllowPrMerge,
    allowBranchDelete: config.githubAllowBranchDelete,
    allowForcePush: config.githubAllowForcePush,
    maxPrBodyChars: config.githubMaxPrBodyChars,
    maxReviewComments: config.githubMaxReviewComments,
    maxCiLogChars: config.githubMaxCiLogChars,
    maxApiRequestsPerSession: config.githubMaxApiRequestsPerSession,
    requestTimeoutMs: config.githubRequestTimeoutMs,
    ciPollIntervalMs: config.githubCiPollIntervalMs,
    ciMaxWaitMs: config.githubCiMaxWaitMs,
  };
}

function manifestPullReference(
  manifest: GitHubTaskManifest,
  reference: RepositoryReference,
): PullRequestReference {
  const number = manifest.remote?.pullRequest?.number;
  if (number === undefined)
    throw new PullRequestNotFoundError("Manifest zadania nie zawiera Pull Request.");
  return { repository: reference, number };
}

export class RemoteRuntimeService {
  private readonly authentication = new GitHubAuthentication();
  private readonly resolver: GitHubRepositoryResolver;
  private readonly ci = new CiAnalysisService();
  private provider: GitHubProvider | undefined;
  private reference: RepositoryReference | undefined;
  private user: RemoteUser | undefined;
  private permissions: RepositoryPermissions | undefined;
  private readonly watches = new Set<AbortController>();

  public constructor(
    private readonly config: AgentConfig,
    private readonly sessionId: string,
  ) {
    this.resolver = new GitHubRepositoryResolver({
      expectedHost: new URL(config.githubWebBaseUrl).hostname,
      allowEnterprise: config.githubAllowEnterprise,
    });
  }

  public async authenticateWithEnvironment(
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<RemoteUser> {
    this.ensureEnabled();
    await this.authentication.connectFromEnvironment(env);
    return this.connectProvider();
  }

  public async authenticateWithToken(
    token: string,
    source: "vscode" | "credential_store" = "vscode",
  ): Promise<RemoteUser> {
    this.ensureEnabled();
    this.authentication.connect(token, source);
    return this.connectProvider();
  }

  private async connectProvider(): Promise<RemoteUser> {
    const audit = new RemoteAuditService(
      join(this.config.workspace, ".agent", "history", "remote-operations.jsonl"),
    );
    this.provider = new GitHubProvider({
      config: providerConfig(this.config),
      authentication: this.authentication,
      audit,
      sessionId: this.sessionId,
    });
    const startedAt = Date.now();
    try {
      this.user = await this.provider.getAuthenticatedUser();
      await audit.record({
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        provider: "github",
        action: "authenticate",
        approval: "not_required",
        result: "success",
        durationMs: Date.now() - startedAt,
      });
      return this.user;
    } catch (error: unknown) {
      await audit.record({
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        provider: "github",
        action: "authenticate",
        approval: "not_required",
        result: "failed",
        durationMs: Date.now() - startedAt,
        ...(typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? { errorCode: error.code }
          : {}),
      });
      throw error;
    }
  }

  public disconnect(): void {
    for (const controller of this.watches) controller.abort();
    this.watches.clear();
    this.provider?.disconnect();
    this.provider = undefined;
    this.reference = undefined;
    this.user = undefined;
    this.permissions = undefined;
  }

  public cancelWatches(): void {
    for (const controller of this.watches) controller.abort();
    this.watches.clear();
  }

  public async getPublishedBranch(taskId: string): Promise<Record<string, unknown>> {
    const manifest = await loadTaskManifest(this.config.workspace, taskId);
    return manifest.remote?.publishedBranch ?? {};
  }

  public async detectRepository(remoteName?: string): Promise<RepositoryReference> {
    this.ensureEnabled();
    this.reference = await this.resolver.resolve(this.config.workspace, remoteName);
    return this.reference;
  }

  public async verifyRepository(remoteName?: string): Promise<{
    repository: RepositoryReference;
    user: RemoteUser;
    permissions: RepositoryPermissions;
  }> {
    const provider = this.requireProvider();
    const reference = await this.detectRepository(remoteName);
    const verified = await provider.verifyRepository(reference);
    this.user = verified.user;
    this.permissions = verified.permissions;
    return { repository: reference, user: verified.user, permissions: verified.permissions };
  }

  public async status(): Promise<Record<string, unknown>> {
    if (!this.config.remoteEnabled)
      return {
        enabled: false,
        provider: "github",
        authenticated: false,
        verified: false,
        warnings: [],
      };
    const warnings: string[] = [];
    if (!this.authentication.isAuthenticated()) warnings.push("GitHub nie jest uwierzytelniony.");
    return {
      enabled: true,
      provider: "github",
      authenticated: this.authentication.isAuthenticated(),
      ...(this.user === undefined
        ? {}
        : {
            user: {
              login: this.user.login,
              ...(this.user.name === undefined ? {} : { name: this.user.name }),
            },
          }),
      ...(this.reference === undefined
        ? {}
        : {
            repository: {
              ...this.reference,
              verified: this.provider?.getTrust(this.reference) !== "unverified",
            },
          }),
      ...(this.permissions === undefined ? {} : { permissions: this.permissions }),
      warnings,
    };
  }

  public async preparePublish(taskId: string, remoteName?: string): Promise<PreparedPublish> {
    const provider = this.requireProvider();
    const manifest = await loadTaskManifest(this.config.workspace, taskId);
    const verified = await this.verifyRepository(remoteName);
    const workspacePath = await this.validatedWorktree(manifest.workspacePath);
    const localHead = manifest.commits.at(-1)?.sha;
    if (localHead === undefined || !/^[0-9a-f]{40}$/i.test(localHead))
      throw new PullRequestCreateError("Manifest nie zawiera pełnego SHA lokalnego commita.");
    const approvalId = await provider.prepareApproval(
      "publish_branch",
      verified.repository,
      `git push ${verified.repository.remoteName} refs/heads/${manifest.branch}:refs/heads/${manifest.branch}`,
      taskId,
    );
    return {
      approvalId,
      taskId,
      repository: verified.repository,
      branch: manifest.branch,
      commits: manifest.commits.length,
      localHead,
      ...(manifest.remote?.publishedBranch?.remoteHead === undefined
        ? {}
        : { expectedRemoteHead: manifest.remote.publishedBranch.remoteHead }),
      workspacePath,
    };
  }

  public async executePublish(
    prepared: PreparedPublish,
    approved: boolean,
  ): Promise<GitHubTaskManifest> {
    const provider = this.requireProvider();
    provider.decideApproval(prepared.approvalId, approved ? "approved" : "denied", "user_cli");
    if (!approved) throw new PullRequestCreateError("Użytkownik anulował publikację.");
    const result = await provider.publishBranch({
      repository: prepared.repository,
      taskId: prepared.taskId,
      workspacePath: prepared.workspacePath,
      branch: prepared.branch,
      localHead: prepared.localHead,
      ...(prepared.expectedRemoteHead === undefined
        ? {}
        : { expectedRemoteHead: prepared.expectedRemoteHead }),
      approvalId: prepared.approvalId,
    });
    const manifest = await loadTaskManifest(this.config.workspace, prepared.taskId);
    manifest.remote = {
      provider: "github",
      repository: {
        host: prepared.repository.host,
        owner: prepared.repository.owner,
        name: prepared.repository.repository,
        remoteName: prepared.repository.remoteName,
      },
      ...manifest.remote,
      publishedBranch: {
        name: result.branch,
        remoteHead: result.remoteHead,
        publishedAt: result.publishedAt,
      },
    };
    await saveTaskManifest(this.config.workspace, manifest);
    return manifest;
  }

  public async prepareCreatePullRequest(
    taskId: string,
    options: { title?: string; summary?: string; issueNumber?: number; labels?: string[] } = {},
  ): Promise<PreparedPullRequest> {
    const provider = this.requireProvider();
    const manifest = await loadTaskManifest(this.config.workspace, taskId);
    if (manifest.remote?.publishedBranch === undefined)
      throw new PullRequestCreateError("Najpierw opublikuj gałąź zadania.");
    const reference = await this.referenceForManifest(manifest);
    await provider.verifyRepository(reference);
    const fallbackTitle =
      manifest.commits.at(-1)?.subject ?? manifest.goal ?? `chore: complete ${taskId}`;
    const title = validatePullRequestTitle((options.title ?? fallbackTitle).slice(0, 72));
    const body = buildPullRequestBody(
      {
        goal:
          options.summary ??
          manifest.goal ??
          manifest.finalReview.summary ??
          "Publikacja ukończonego zadania lokalnego agenta.",
        changes: manifest.commits.map((commit) => commit.subject),
        changedAreas: manifest.changedFiles ?? [],
        verification: manifest.verification ?? [],
        risks: manifest.finalReview.summary === undefined ? [] : [manifest.finalReview.summary],
        taskId,
        commits: manifest.commits.length,
        ...(options.issueNumber === undefined
          ? {}
          : { issueNumber: options.issueNumber, issueLinkKeyword: "Closes" }),
      },
      this.config.githubMaxPrBodyChars,
    );
    const approvalId = await provider.prepareApproval(
      "create_pull_request",
      reference,
      `Create Draft PR: ${title}`,
      taskId,
    );
    return {
      approvalId,
      manifest,
      repository: reference,
      title,
      body,
      ...(options.issueNumber === undefined ? {} : { issueNumber: options.issueNumber }),
      ...(options.labels === undefined ? {} : { labels: options.labels }),
    };
  }

  public async executeCreatePullRequest(
    prepared: PreparedPullRequest,
    approved: boolean,
  ): Promise<PullRequest> {
    const provider = this.requireProvider();
    provider.decideApproval(prepared.approvalId, approved ? "approved" : "denied", "user_cli");
    if (!approved) throw new PullRequestCreateError("Użytkownik anulował utworzenie PR.");
    const pull = await provider.createPullRequest({
      repository: prepared.repository,
      taskId: prepared.manifest.id,
      title: prepared.title,
      body: prepared.body,
      headBranch: prepared.manifest.branch,
      baseBranch: prepared.manifest.baseBranch,
      draft: true,
      ...(prepared.issueNumber === undefined ? {} : { issueNumber: prepared.issueNumber }),
      ...(prepared.labels === undefined ? {} : { labels: prepared.labels }),
      approvalId: prepared.approvalId,
    });
    prepared.manifest.remote = {
      provider: "github",
      repository: {
        host: prepared.repository.host,
        owner: prepared.repository.owner,
        name: prepared.repository.repository,
        remoteName: prepared.repository.remoteName,
      },
      ...prepared.manifest.remote,
      pullRequest: {
        number: pull.number,
        url: pull.url,
        state: pull.state,
        draft: pull.draft,
        headSha: pull.headSha,
        baseBranch: pull.baseBranch,
        createdAt: pull.createdAt,
        updatedAt: pull.updatedAt,
      },
    };
    await saveTaskManifest(this.config.workspace, prepared.manifest);
    return pull;
  }

  public async getPullRequest(taskId: string): Promise<PullRequest> {
    const { provider, reference, manifest } = await this.taskContext(taskId);
    return provider.getPullRequest(manifestPullReference(manifest, reference));
  }

  public async prepareUpdatePullRequest(
    taskId: string,
    options: {
      title?: string;
      summary?: string;
      issueNumber?: number;
      issueKeyword?: "Closes" | "Fixes" | "Refs";
      labels?: string[];
    },
  ): Promise<PreparedPullRequestUpdate> {
    const { provider, reference, manifest } = await this.taskContext(taskId);
    const pullReference = manifestPullReference(manifest, reference);
    const current = await provider.getPullRequest(pullReference);
    if (options.issueNumber !== undefined)
      await provider.validateIssue(reference, options.issueNumber);
    if (options.labels !== undefined) await provider.validateLabels(reference, options.labels);
    const title = options.title === undefined ? undefined : validatePullRequestTitle(options.title);
    const body =
      options.summary === undefined && options.issueNumber === undefined
        ? undefined
        : buildPullRequestBody(
            {
              goal:
                options.summary ??
                manifest.goal ??
                manifest.finalReview.summary ??
                "Aktualizacja ukończonego zadania lokalnego agenta.",
              changes: manifest.commits.map((commit) => commit.subject),
              changedAreas: manifest.changedFiles ?? [],
              verification: manifest.verification ?? [],
              risks:
                manifest.finalReview.summary === undefined ? [] : [manifest.finalReview.summary],
              taskId,
              commits: manifest.commits.length,
              ...(options.issueNumber === undefined
                ? {}
                : {
                    issueNumber: options.issueNumber,
                    issueLinkKeyword: options.issueKeyword ?? "Refs",
                  }),
            },
            this.config.githubMaxPrBodyChars,
          );
    const diff = pullRequestMetadataDiff(current, {
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
      ...(options.labels === undefined ? {} : { labels: options.labels }),
    });
    if (diff === "") throw new PullRequestCreateError("Aktualizacja nie zmienia metadanych PR.");
    const approvalId = await provider.prepareApproval(
      "update_pull_request",
      reference,
      diff,
      taskId,
    );
    return {
      approvalId,
      manifest,
      repository: reference,
      reference: pullReference,
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
      ...(options.labels === undefined ? {} : { labels: options.labels }),
      diff,
    };
  }

  public async executeUpdatePullRequest(
    prepared: PreparedPullRequestUpdate,
    approved: boolean,
  ): Promise<PullRequest> {
    const provider = this.requireProvider();
    provider.decideApproval(prepared.approvalId, approved ? "approved" : "denied", "user_cli");
    if (!approved) throw new PullRequestCreateError("Użytkownik anulował aktualizację PR.");
    const pull = await provider.updatePullRequest({
      reference: prepared.reference,
      ...(prepared.title === undefined ? {} : { title: prepared.title }),
      ...(prepared.body === undefined ? {} : { body: prepared.body }),
      ...(prepared.labels === undefined ? {} : { labels: prepared.labels }),
      approvalId: prepared.approvalId,
    });
    prepared.manifest.remote = {
      ...prepared.manifest.remote!,
      pullRequest: {
        number: pull.number,
        url: pull.url,
        state: pull.state,
        draft: pull.draft,
        headSha: pull.headSha,
        baseBranch: pull.baseBranch,
        createdAt: pull.createdAt,
        updatedAt: pull.updatedAt,
      },
    };
    await saveTaskManifest(this.config.workspace, prepared.manifest);
    return pull;
  }

  public async listChecks(taskId: string): Promise<CheckRunSummary[]> {
    const { provider, reference, manifest } = await this.taskContext(taskId);
    const checks = await provider.listPullRequestChecks(manifestPullReference(manifest, reference));
    manifest.remote = {
      ...manifest.remote!,
      ci: {
        lastCheckedAt: new Date().toISOString(),
        status:
          checks.length === 0
            ? "no_checks"
            : checks.every((check) => check.status === "completed")
              ? "completed"
              : "pending",
        failedChecks: checks.filter((check) => check.conclusion === "failure").length,
      },
    };
    await saveTaskManifest(this.config.workspace, manifest);
    return checks;
  }

  public async watchChecks(taskId: string, signal?: AbortSignal): Promise<CheckRunSummary[]> {
    const { provider, reference, manifest } = await this.taskContext(taskId);
    const controller = new AbortController();
    this.watches.add(controller);
    const relay = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", relay, { once: true });
    try {
      return await provider.watchPullRequestChecks(
        manifestPullReference(manifest, reference),
        "until_complete",
        controller.signal,
      );
    } finally {
      signal?.removeEventListener("abort", relay);
      this.watches.delete(controller);
    }
  }

  public async getCheckLogs(taskId: string, checkId: string): Promise<CheckLogResult> {
    const { provider, reference, manifest } = await this.taskContext(taskId);
    return provider.getCheckLogs({ ...manifestPullReference(manifest, reference), checkId });
  }

  public async analyzeCheck(taskId: string, checkId: string): Promise<CiFailureAnalysis> {
    const [log, checks] = await Promise.all([
      this.getCheckLogs(taskId, checkId),
      this.listChecks(taskId),
    ]);
    const check = checks.find((item) => item.id === checkId);
    if (check === undefined)
      throw new PullRequestNotFoundError("Nie znaleziono checku w bieżącym PR.");
    return this.ci.analyze({
      checkId,
      checkName: check.name,
      log: log.content,
      ...(check.conclusion === undefined ? {} : { conclusion: check.conclusion }),
      maxLogChars: this.config.githubMaxCiLogChars,
    });
  }

  public async listReviewThreads(taskId: string): Promise<ReviewThread[]> {
    const { provider, reference, manifest } = await this.taskContext(taskId);
    return provider.listReviewThreads(manifestPullReference(manifest, reference));
  }

  public async listReviews(taskId: string): Promise<Record<string, unknown>[]> {
    const { provider, reference, manifest } = await this.taskContext(taskId);
    const result = await provider.listReviews(manifestPullReference(manifest, reference));
    return [
      ...result.reviews.map((review) => ({ kind: "review", ...review })),
      ...result.comments.map((comment) => ({ kind: "comment", ...comment })),
    ];
  }

  public async prepareReviewReply(
    taskId: string,
    threadId: string,
    body: string,
    commitSha: string,
  ): Promise<{ approvalId: string; reference: PullRequestReference }> {
    const { provider, reference, manifest } = await this.taskContext(taskId);
    const pullReference = manifestPullReference(manifest, reference);
    const approvalId = await provider.prepareApproval(
      "reply_review",
      reference,
      `Reply to review thread ${threadId}`,
      taskId,
    );
    void body;
    void commitSha;
    return { approvalId, reference: pullReference };
  }

  public async executeReviewReply(input: {
    taskId: string;
    threadId: string;
    body: string;
    commitSha: string;
    approvalId: string;
    approved: boolean;
  }): Promise<ReviewComment> {
    const { provider, reference, manifest } = await this.taskContext(input.taskId);
    provider.decideApproval(input.approvalId, input.approved ? "approved" : "denied", "user_cli");
    if (!input.approved) throw new PullRequestCreateError("Użytkownik anulował odpowiedź.");
    return provider.replyToReviewThread({
      reference: manifestPullReference(manifest, reference),
      threadId: input.threadId,
      body: input.body,
      commitSha: input.commitSha,
      approvalId: input.approvalId,
    });
  }

  public async prepareResolveThread(
    taskId: string,
    threadId: string,
  ): Promise<{ approvalId: string }> {
    const { provider, reference } = await this.taskContext(taskId);
    return {
      approvalId: await provider.prepareApproval(
        "resolve_thread",
        reference,
        `Resolve review thread ${threadId}`,
        taskId,
      ),
    };
  }

  public async executeResolveThread(input: {
    taskId: string;
    threadId: string;
    approvalId: string;
    approved: boolean;
  }): Promise<void> {
    const { provider, reference, manifest } = await this.taskContext(input.taskId);
    provider.decideApproval(input.approvalId, input.approved ? "approved" : "denied", "user_cli");
    if (!input.approved) throw new PullRequestCreateError("Użytkownik anulował rozwiązanie wątku.");
    await provider.resolveReviewThread({
      reference: manifestPullReference(manifest, reference),
      threadId: input.threadId,
      approvalId: input.approvalId,
    });
  }

  public async rateLimit(): Promise<unknown> {
    return this.requireProvider().getRateLimit();
  }

  private async taskContext(taskId: string): Promise<{
    provider: GitHubProvider;
    reference: RepositoryReference;
    manifest: GitHubTaskManifest;
  }> {
    const provider = this.requireProvider();
    const manifest = await loadTaskManifest(this.config.workspace, taskId);
    const reference = await this.referenceForManifest(manifest);
    await provider.verifyRepository(reference);
    return { provider, reference, manifest };
  }

  private async referenceForManifest(manifest: GitHubTaskManifest): Promise<RepositoryReference> {
    const stored = manifest.remote?.repository;
    const detected = await this.detectRepository(stored?.remoteName);
    if (stored !== undefined) {
      const expected =
        `${stored.host}/${stored.owner}/${stored.name}/${stored.remoteName}`.toLowerCase();
      const actual =
        `${detected.host}/${detected.owner}/${detected.repository}/${detected.remoteName}`.toLowerCase();
      if (expected !== actual)
        throw new PullRequestCreateError("Remote zmienił się od zapisania manifestu zadania.");
    }
    return detected;
  }

  private async validatedWorktree(value: string): Promise<string> {
    const candidate = await realpath(
      isAbsolute(value) ? value : resolve(this.config.workspace, value),
    );
    const withinAgentParent = relative(
      resolve(this.config.workspace, ".agent", "worktrees"),
      candidate,
    );
    if (
      withinAgentParent === "" ||
      withinAgentParent.startsWith("..") ||
      isAbsolute(withinAgentParent)
    ) {
      throw new PullRequestCreateError("Worktree zadania znajduje się poza dozwolonym katalogiem.");
    }
    return candidate;
  }

  private requireProvider(): GitHubProvider {
    this.ensureEnabled();
    if (this.provider === undefined) throw new RemoteAuthenticationRequiredError();
    return this.provider;
  }

  private ensureEnabled(): void {
    if (!this.config.remoteEnabled) throw new RemoteIntegrationDisabledError();
  }
}

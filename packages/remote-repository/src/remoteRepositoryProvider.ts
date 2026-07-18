import type {
  CheckLogResult,
  CheckReference,
  CheckRunSummary,
  CreatePullRequestInput,
  GitHubRateLimitState,
  PublishBranchInput,
  PublishBranchResult,
  PullRequest,
  PullRequestReference,
  RemoteBranch,
  RemoteRepository,
  RemoteUser,
  RepositoryPermissions,
  RepositoryReference,
  ResolveReviewThreadInput,
  ReviewComment,
  ReviewThread,
  ReplyToReviewThreadInput,
  UpdatePullRequestInput,
} from "./remoteRepositoryTypes.js";

export interface RemoteRepositoryProvider {
  readonly name: "github";
  getAuthenticatedUser(): Promise<RemoteUser>;
  getRepository(reference: RepositoryReference): Promise<RemoteRepository>;
  getRepositoryPermissions(reference: RepositoryReference): Promise<RepositoryPermissions>;
  listBranches(reference: RepositoryReference): Promise<RemoteBranch[]>;
  publishBranch(input: PublishBranchInput): Promise<PublishBranchResult>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  updatePullRequest(input: UpdatePullRequestInput): Promise<PullRequest>;
  getPullRequest(reference: PullRequestReference): Promise<PullRequest>;
  listPullRequestChecks(reference: PullRequestReference): Promise<CheckRunSummary[]>;
  getCheckLogs(reference: CheckReference): Promise<CheckLogResult>;
  listReviewThreads(reference: PullRequestReference): Promise<ReviewThread[]>;
  replyToReviewThread(input: ReplyToReviewThreadInput): Promise<ReviewComment>;
  resolveReviewThread(input: ResolveReviewThreadInput): Promise<void>;
  getRateLimit(): Promise<GitHubRateLimitState>;
  disconnect(): void;
}

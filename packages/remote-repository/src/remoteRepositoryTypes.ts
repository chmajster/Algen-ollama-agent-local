export type RemoteProviderName = "github";
export type RemoteUrlType = "ssh" | "https";
export type RepositoryTrustState =
  "unverified" | "verified_for_session" | "verified_for_workspace" | "blocked";

export interface RepositoryReference {
  provider: RemoteProviderName;
  host: string;
  owner: string;
  repository: string;
  remoteName: string;
  remoteUrlType: RemoteUrlType;
}

export interface RemoteUser {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
}

export interface RemoteRepository {
  id: string;
  reference: RepositoryReference;
  defaultBranch: string;
  private: boolean;
  fork: boolean;
  webUrl: string;
}

export interface RepositoryPermissions {
  read: boolean;
  triage: boolean;
  write: boolean;
  maintain: boolean;
  admin: boolean;
  canPush: boolean;
  canCreatePullRequest: boolean;
  canComment: boolean;
  canManageIssues: boolean;
  canResolveReviewThreads: boolean;
}

export interface RemoteBranch {
  name: string;
  commitSha: string;
  protected: boolean;
}

export interface PublishBranchInput {
  repository: RepositoryReference;
  taskId: string;
  workspacePath: string;
  branch: string;
  localHead: string;
  expectedRemoteHead?: string;
  approvalId: string;
}

export interface PublishBranchResult {
  branch: string;
  remoteName: string;
  localHead: string;
  remoteHead: string;
  publishedAt: string;
  created: boolean;
}

export interface PullRequestReference {
  repository: RepositoryReference;
  number: number;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "open" | "closed";
  draft: boolean;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  labels: string[];
  issueNumber?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePullRequestInput {
  repository: RepositoryReference;
  taskId: string;
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
  draft: boolean;
  issueNumber?: number;
  labels?: string[];
  approvalId: string;
}

export interface UpdatePullRequestInput {
  reference: PullRequestReference;
  title?: string;
  body?: string;
  labels?: string[];
  approvalId: string;
}

export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "stale"
  | "unknown";

export interface CheckRunSummary {
  id: string;
  name: string;
  provider: "github_actions" | "external";
  status: "queued" | "in_progress" | "completed";
  conclusion?: CheckConclusion;
  startedAt?: string;
  completedAt?: string;
  detailsUrl?: string;
  workflowName?: string;
  jobName?: string;
  commitSha: string;
}

export interface CheckReference extends PullRequestReference {
  checkId: string;
}

export interface CheckLogResult {
  checkId: string;
  content: string;
  truncated: boolean;
  redactions: number;
  errorBlocks: string[];
  promptInjectionWarning?: boolean;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
  commitSha?: string;
  url?: string;
}

export interface PullRequestReviewSummary {
  id: string;
  author: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING" | "UNKNOWN";
  body: string;
  submittedAt?: string;
  commitSha?: string;
  securityWarnings?: string[];
}

export interface PullRequestConversationComment extends ReviewComment {
  securityWarnings?: string[];
}

export type ReviewClassification =
  "actionable" | "question" | "suggestion" | "praise" | "informational" | "obsolete" | "unknown";

export interface ReviewThread {
  id: string;
  path?: string;
  line?: number;
  originalLine?: number;
  side?: "LEFT" | "RIGHT";
  resolved: boolean;
  outdated: boolean;
  comments: ReviewComment[];
  classification?: ReviewClassification;
  securityWarnings?: string[];
}

export interface ReplyToReviewThreadInput {
  reference: PullRequestReference;
  threadId: string;
  body: string;
  commitSha?: string;
  approvalId: string;
}

export interface ResolveReviewThreadInput {
  reference: PullRequestReference;
  threadId: string;
  approvalId: string;
}

export interface GitHubRateLimitState {
  limit: number;
  remaining: number;
  resetAt: string;
  used: number;
  resource: string;
}

export type RemoteOperationAction =
  | "authenticate"
  | "verify_repository"
  | "publish_branch"
  | "create_pull_request"
  | "update_pull_request"
  | "read_checks"
  | "read_logs"
  | "read_reviews"
  | "reply_review"
  | "resolve_thread";

export interface RemoteOperationAuditEntry {
  timestamp: string;
  sessionId: string;
  taskId?: string;
  provider: "github";
  repository?: string;
  action: RemoteOperationAction;
  approval: "not_required" | "allowed_once" | "denied";
  result: "success" | "failed" | "timeout" | "blocked" | "cancelled";
  branch?: string;
  pullRequestNumber?: number;
  commitSha?: string;
  errorCode?: string;
  durationMs?: number;
}

export interface RemoteStatistics {
  remoteApiRequests: number;
  remoteApiFailures: number;
  remoteRateLimitWarnings: number;
  branchesPublished: number;
  branchPublishFailures: number;
  pullRequestsCreated: number;
  pullRequestsUpdated: number;
  ciChecksRead: number;
  ciChecksFailed: number;
  ciLogsRead: number;
  ciFailuresAnalyzed: number;
  reviewThreadsRead: number;
  actionableReviewThreads: number;
  reviewRepliesSent: number;
  reviewThreadsResolved: number;
  remoteApprovalsRequested: number;
  remoteApprovalsGranted: number;
  remoteApprovalsDenied: number;
  remotePromptInjectionWarnings: number;
}

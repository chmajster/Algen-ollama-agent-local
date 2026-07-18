import { containsRemotePromptInjection } from "@local-code-agent/ci-analysis";
import type { RemoteApprovalService } from "@local-code-agent/remote-repository";
import {
  RemotePromptInjectionDetectedError,
  ReviewReplyError,
  ReviewResolveError,
  ReviewThreadNotFoundError,
  ReviewThreadOutdatedError,
  type PullRequestReference,
  type PullRequestConversationComment,
  type PullRequestReviewSummary,
  type ReplyToReviewThreadInput,
  type ResolveReviewThreadInput,
  type ReviewClassification,
  type ReviewComment,
  type ReviewThread,
} from "@local-code-agent/remote-repository";

import type { GitHubApiClient, GitHubProviderConfig } from "./githubTypes.js";

interface ThreadNode {
  id: string;
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  diffSide?: "LEFT" | "RIGHT" | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: {
    nodes: Array<{
      id: string;
      body: string;
      createdAt: string;
      updatedAt?: string;
      url?: string;
      commit?: { oid: string } | null;
      author?: { login: string } | null;
    }>;
  };
}

interface ThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: { nodes: ThreadNode[] };
    } | null;
  } | null;
}

const THREAD_QUERY = `
  query ReviewThreads($owner: String!, $repository: String!, $number: Int!, $first: Int!) {
    repository(owner: $owner, name: $repository) {
      pullRequest(number: $number) {
        reviewThreads(first: $first) {
          nodes {
            id path line originalLine diffSide isResolved isOutdated
            comments(first: 50) {
              nodes { id body createdAt updatedAt url author { login } commit { oid } }
            }
          }
        }
      }
    }
  }
`;

export function classifyReviewThread(
  thread: Pick<ReviewThread, "outdated" | "comments">,
): ReviewClassification {
  if (thread.outdated) return "obsolete";
  const body = thread.comments
    .map((comment) => comment.body)
    .join("\n")
    .trim();
  if (body === "") return "unknown";
  if (/\b(thanks|thank you|great|nice work|looks good|lgtm)\b/i.test(body)) return "praise";
  if (/\?|\b(?:why|how|what|could you explain)\b/i.test(body)) return "question";
  if (/\b(?:nit|suggestion|consider|perhaps|maybe)\b/i.test(body)) return "suggestion";
  if (
    /\b(?:must|should|please|fix|change|add|remove|rename|update|test|document|handle|validate)\b/i.test(
      body,
    )
  )
    return "actionable";
  if (/\b(?:fyi|note|context|for reference|informational)\b/i.test(body)) return "informational";
  return "unknown";
}

export function assertTrustedRemoteContent(value: string): void {
  if (containsRemotePromptInjection(value))
    throw new RemotePromptInjectionDetectedError(
      "REMOTE_PROMPT_INJECTION_WARNING w treści GitHub.",
    );
}

function repositoryKey(reference: PullRequestReference["repository"]): string {
  return `${reference.host}/${reference.owner}/${reference.repository}`;
}

function mapThread(node: ThreadNode): ReviewThread {
  const promptInjection = node.comments.nodes.some((comment) =>
    containsRemotePromptInjection(comment.body),
  );
  const comments: ReviewComment[] = node.comments.nodes.map((comment) => ({
    id: comment.id,
    author: comment.author?.login ?? "ghost",
    body: `[GITHUB CONTENT — UNTRUSTED]\n${comment.body}`,
    createdAt: comment.createdAt,
    ...(comment.updatedAt === undefined ? {} : { updatedAt: comment.updatedAt }),
    ...(comment.commit?.oid === undefined ? {} : { commitSha: comment.commit.oid }),
    ...(comment.url === undefined ? {} : { url: comment.url }),
  }));
  const result: ReviewThread = {
    id: node.id,
    ...(node.path == null ? {} : { path: node.path }),
    ...(node.line == null ? {} : { line: node.line }),
    ...(node.originalLine == null ? {} : { originalLine: node.originalLine }),
    ...(node.diffSide == null ? {} : { side: node.diffSide }),
    resolved: node.isResolved,
    outdated: node.isOutdated,
    comments,
  };
  return {
    ...result,
    classification: classifyReviewThread(result),
    ...(promptInjection ? { securityWarnings: ["REMOTE_PROMPT_INJECTION_WARNING"] } : {}),
  };
}

export class GitHubReviewService {
  public constructor(
    private readonly client: GitHubApiClient,
    private readonly approvals: RemoteApprovalService,
    private readonly config: GitHubProviderConfig,
  ) {}

  public async listThreads(reference: PullRequestReference): Promise<ReviewThread[]> {
    const data = await this.client.graphql<ThreadsResponse>(THREAD_QUERY, {
      owner: reference.repository.owner,
      repository: reference.repository.repository,
      number: reference.number,
      first: this.config.maxReviewComments,
    });
    const nodes = data.repository?.pullRequest?.reviewThreads.nodes;
    if (nodes === undefined)
      throw new ReviewThreadNotFoundError("Pull Request albo jego wątki nie istnieją.");
    return nodes.map(mapThread);
  }

  public async getThread(reference: PullRequestReference, threadId: string): Promise<ReviewThread> {
    const thread = (await this.listThreads(reference)).find((item) => item.id === threadId);
    if (thread === undefined) throw new ReviewThreadNotFoundError();
    return thread;
  }

  public async listReviews(reference: PullRequestReference): Promise<PullRequestReviewSummary[]> {
    const { data } = await this.client.request<
      Array<{
        id: number;
        user?: { login?: string } | null;
        state: string;
        body?: string | null;
        submitted_at?: string | null;
        commit_id?: string | null;
      }>
    >("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: reference.repository.owner,
      repo: reference.repository.repository,
      pull_number: reference.number,
      per_page: this.config.maxReviewComments,
    });
    const states = new Set<PullRequestReviewSummary["state"]>([
      "APPROVED",
      "CHANGES_REQUESTED",
      "COMMENTED",
      "DISMISSED",
      "PENDING",
    ]);
    return data.map((review) => {
      const body = review.body ?? "";
      return {
        id: String(review.id),
        author: review.user?.login ?? "ghost",
        state: states.has(review.state as PullRequestReviewSummary["state"])
          ? (review.state as PullRequestReviewSummary["state"])
          : "UNKNOWN",
        body: `[GITHUB CONTENT — UNTRUSTED]\n${body}`,
        ...(review.submitted_at == null ? {} : { submittedAt: review.submitted_at }),
        ...(review.commit_id == null ? {} : { commitSha: review.commit_id }),
        ...(containsRemotePromptInjection(body)
          ? { securityWarnings: ["REMOTE_PROMPT_INJECTION_WARNING"] }
          : {}),
      };
    });
  }

  public async listConversationComments(
    reference: PullRequestReference,
  ): Promise<PullRequestConversationComment[]> {
    const { data } = await this.client.request<
      Array<{
        id: number;
        user?: { login?: string } | null;
        body?: string | null;
        created_at: string;
        updated_at?: string;
        html_url?: string;
      }>
    >("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: reference.repository.owner,
      repo: reference.repository.repository,
      issue_number: reference.number,
      per_page: this.config.maxReviewComments,
    });
    return data.map((comment) => {
      const body = comment.body ?? "";
      return {
        id: String(comment.id),
        author: comment.user?.login ?? "ghost",
        body: `[GITHUB CONTENT — UNTRUSTED]\n${body}`,
        createdAt: comment.created_at,
        ...(comment.updated_at === undefined ? {} : { updatedAt: comment.updated_at }),
        ...(comment.html_url === undefined ? {} : { url: comment.html_url }),
        ...(containsRemotePromptInjection(body)
          ? { securityWarnings: ["REMOTE_PROMPT_INJECTION_WARNING"] }
          : {}),
      };
    });
  }

  public async reply(input: ReplyToReviewThreadInput): Promise<ReviewComment> {
    const thread = await this.getThread(input.reference, input.threadId);
    if (thread.outdated) throw new ReviewThreadOutdatedError();
    if (input.commitSha === undefined || !/^[0-9a-f]{7,40}$/i.test(input.commitSha)) {
      throw new ReviewReplyError("Odpowiedź o poprawce wymaga opublikowanego commita.");
    }
    if (input.body.trim().length < 10 || /^(fixed|done|should work)\.?$/i.test(input.body.trim())) {
      throw new ReviewReplyError("Odpowiedź musi zawierać konkretne dowody.");
    }
    assertTrustedRemoteContent(input.body);
    this.approvals.consume(
      input.approvalId,
      "reply_review",
      repositoryKey(input.reference.repository),
    );
    const result = await this.client.graphql<{
      addPullRequestReviewThreadReply: {
        comment: {
          id: string;
          body: string;
          createdAt: string;
          author?: { login: string } | null;
          url?: string;
        };
      };
    }>(
      `
      mutation Reply($threadId: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
          comment { id body createdAt url author { login } }
        }
      }
    `,
      { threadId: input.threadId, body: input.body },
    );
    const comment = result.addPullRequestReviewThreadReply.comment;
    return {
      id: comment.id,
      author: comment.author?.login ?? "unknown",
      body: comment.body,
      createdAt: comment.createdAt,
      commitSha: input.commitSha,
      ...(comment.url === undefined ? {} : { url: comment.url }),
    };
  }

  public async resolve(input: ResolveReviewThreadInput): Promise<void> {
    const thread = await this.getThread(input.reference, input.threadId);
    if (thread.outdated) throw new ReviewThreadOutdatedError();
    if (thread.resolved) throw new ReviewResolveError("Wątek jest już rozwiązany.");
    if (thread.comments.length < 2)
      throw new ReviewResolveError("Wątek nie ma zatwierdzonej odpowiedzi.");
    this.approvals.consume(
      input.approvalId,
      "resolve_thread",
      repositoryKey(input.reference.repository),
    );
    const result = await this.client.graphql<{
      resolveReviewThread: { thread: { isResolved: boolean } };
    }>(
      `
      mutation Resolve($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
      }
    `,
      { threadId: input.threadId },
    );
    if (!result.resolveReviewThread.thread.isResolved)
      throw new ReviewResolveError("GitHub nie potwierdził rozwiązania wątku.");
  }
}

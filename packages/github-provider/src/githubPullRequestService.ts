import type { RemoteApprovalService } from "@local-code-agent/remote-repository";
import {
  PullRequestAlreadyExistsError,
  PullRequestBodyLimitError,
  PullRequestCreateError,
  PullRequestNotFoundError,
  PullRequestUpdateError,
  type CreatePullRequestInput,
  type PullRequest,
  type PullRequestReference,
  type RepositoryReference,
  type UpdatePullRequestInput,
} from "@local-code-agent/remote-repository";

import { GitHubIssueService } from "./githubIssueService.js";
import type { GitHubApiClient, GitHubProviderConfig, PullRequestBodyInput } from "./githubTypes.js";

interface GitHubPullRequestData {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  labels?: Array<{ name?: string }>;
  created_at: string;
  updated_at: string;
}

function repositoryKey(reference: RepositoryReference): string {
  return `${reference.host}/${reference.owner}/${reference.repository}`;
}

function mapPullRequest(data: GitHubPullRequestData): PullRequest {
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? "",
    url: data.html_url,
    state: data.state,
    draft: data.draft === true,
    headBranch: data.head.ref,
    headSha: data.head.sha,
    baseBranch: data.base.ref,
    labels: (data.labels ?? []).flatMap((label) => (label.name === undefined ? [] : [label.name])),
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

function safeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized
    .replace(/^[A-Za-z]:\/Users\/[^/]+\//i, "")
    .replace(/^\/Users\/[^/]+\//, "")
    .replace(/^\/home\/[^/]+\//, "")
    .replace(/^\/+/, "")
    .slice(0, 300);
}

export function validatePullRequestTitle(title: string): string {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > 72)
    throw new PullRequestCreateError("Tytuł PR musi mieć od 1 do 72 znaków.");
  if (/^WIP\b/i.test(normalized))
    throw new PullRequestCreateError("Draft PR nie używa prefiksu WIP.");
  if (/\b(?:gh[opurs]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i.test(normalized)) {
    throw new PullRequestCreateError("Tytuł PR zawiera wzorzec sekretu.");
  }
  if (/\ball tests pass(?:ed)?\b/i.test(normalized))
    throw new PullRequestCreateError(
      "Tytuł nie może deklarować niezweryfikowanego sukcesu testów.",
    );
  return normalized;
}

export function buildPullRequestBody(input: PullRequestBodyInput, maxChars = 50_000): string {
  const verification =
    input.verification.length === 0
      ? ["- Weryfikacja: unavailable"]
      : input.verification.map(
          (item) =>
            `- ${item.name}: ${item.status}${item.details === undefined ? "" : ` — ${item.details.slice(0, 300)}`}`,
        );
  const issue =
    input.issueNumber === undefined
      ? "- Brak"
      : `${input.issueLinkKeyword ?? "Refs"} #${input.issueNumber}`;
  const body = [
    "## Cel",
    "",
    input.goal.trim().slice(0, 2_000),
    "",
    "## Zmiany",
    "",
    ...(input.changes.length === 0
      ? ["- Brak danych o zmianach"]
      : input.changes.map((item) => `- ${item.trim().slice(0, 500)}`)),
    "",
    "## Zmienione obszary",
    "",
    ...(input.changedAreas.length === 0
      ? ["- Brak"]
      : input.changedAreas.map((path) => `- \`${safeRelativePath(path)}\``)),
    "",
    "## Weryfikacja",
    "",
    ...verification,
    "",
    "## Ryzyko",
    "",
    ...(input.risks.length === 0
      ? ["- Nie zidentyfikowano dodatkowego ryzyka; wymagane review."]
      : input.risks.map((risk) => `- ${risk.trim().slice(0, 500)}`)),
    "",
    "## Powiązane issue",
    "",
    issue,
    "",
    "## Zadanie lokalnego agenta",
    "",
    `- Task ID: \`${input.taskId}\``,
    `- Commits: ${input.commits}`,
  ].join("\n");
  if (body.length > maxChars)
    throw new PullRequestBodyLimitError(`Opis PR przekracza limit ${maxChars} znaków.`);
  return body;
}

export function pullRequestMetadataDiff(
  before: Pick<PullRequest, "title" | "body" | "labels">,
  after: { title?: string; body?: string; labels?: string[] },
): string {
  const lines: string[] = [];
  if (after.title !== undefined && after.title !== before.title)
    lines.push(`- title: ${before.title}`, `+ title: ${after.title}`);
  if (after.body !== undefined && after.body !== before.body)
    lines.push("- body: [previous]", "+ body: [updated]");
  if (after.labels !== undefined && after.labels.join("\0") !== before.labels.join("\0")) {
    lines.push(`- labels: ${before.labels.join(", ")}`, `+ labels: ${after.labels.join(", ")}`);
  }
  return lines.join("\n");
}

export class GitHubPullRequestService {
  private readonly issues: GitHubIssueService;

  public constructor(
    private readonly client: GitHubApiClient,
    private readonly approvals: RemoteApprovalService,
    private readonly config: GitHubProviderConfig,
  ) {
    this.issues = new GitHubIssueService(client);
  }

  public async create(input: CreatePullRequestInput): Promise<PullRequest> {
    const title = validatePullRequestTitle(input.title);
    if (!input.draft || !this.config.createDraftPullRequest)
      throw new PullRequestCreateError("Na tym etapie można tworzyć wyłącznie Draft Pull Request.");
    if (input.headBranch === input.baseBranch)
      throw new PullRequestCreateError("Gałęzie head i base muszą być różne.");
    if (input.body.length > this.config.maxPrBodyChars) throw new PullRequestBodyLimitError();
    await this.assertBranch(input.repository, input.headBranch);
    await this.assertBranch(input.repository, input.baseBranch);
    const existing = await this.findByHead(input.repository, input.headBranch);
    if (existing !== undefined)
      throw new PullRequestAlreadyExistsError(`Pull Request #${existing.number} już istnieje.`);
    if (input.issueNumber !== undefined)
      await this.issues.assertIssueExists(input.repository, input.issueNumber);
    if (input.labels !== undefined) {
      if (!this.config.allowLabelChanges)
        throw new PullRequestCreateError("Zmiany etykiet są wyłączone.");
      await this.issues.assertLabelsExist(input.repository, input.labels);
    }
    this.approvals.consume(
      input.approvalId,
      "create_pull_request",
      repositoryKey(input.repository),
    );
    const { data } = await this.client.request<GitHubPullRequestData>(
      "POST /repos/{owner}/{repo}/pulls",
      {
        owner: input.repository.owner,
        repo: input.repository.repository,
        title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
        draft: true,
      },
    );
    if (input.labels !== undefined && input.labels.length > 0) {
      await this.client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner: input.repository.owner,
        repo: input.repository.repository,
        issue_number: data.number,
        labels: input.labels,
      });
      data.labels = input.labels.map((name) => ({ name }));
    }
    return {
      ...mapPullRequest(data),
      ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
    };
  }

  public async update(input: UpdatePullRequestInput): Promise<PullRequest> {
    const current = await this.get(input.reference);
    const title = input.title === undefined ? undefined : validatePullRequestTitle(input.title);
    if (input.body !== undefined && input.body.length > this.config.maxPrBodyChars)
      throw new PullRequestBodyLimitError();
    if (input.labels !== undefined) {
      if (!this.config.allowLabelChanges)
        throw new PullRequestUpdateError("Zmiany etykiet są wyłączone.");
      await this.issues.assertLabelsExist(input.reference.repository, input.labels);
    }
    if (
      pullRequestMetadataDiff(current, { ...input, ...(title === undefined ? {} : { title }) }) ===
      ""
    )
      return current;
    this.approvals.consume(
      input.approvalId,
      "update_pull_request",
      repositoryKey(input.reference.repository),
    );
    const { data } = await this.client.request<GitHubPullRequestData>(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: input.reference.repository.owner,
        repo: input.reference.repository.repository,
        pull_number: input.reference.number,
        ...(title === undefined ? {} : { title }),
        ...(input.body === undefined ? {} : { body: input.body }),
      },
    );
    if (input.labels !== undefined) {
      await this.client.request("PUT /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner: input.reference.repository.owner,
        repo: input.reference.repository.repository,
        issue_number: input.reference.number,
        labels: input.labels,
      });
      data.labels = input.labels.map((name) => ({ name }));
    }
    return mapPullRequest(data);
  }

  public async get(reference: PullRequestReference): Promise<PullRequest> {
    try {
      const { data } = await this.client.request<GitHubPullRequestData>(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner: reference.repository.owner,
          repo: reference.repository.repository,
          pull_number: reference.number,
        },
      );
      return mapPullRequest(data);
    } catch (error: unknown) {
      throw new PullRequestNotFoundError(undefined, { cause: error });
    }
  }

  public async findByHead(
    reference: RepositoryReference,
    headBranch: string,
  ): Promise<PullRequest | undefined> {
    const { data } = await this.client.request<GitHubPullRequestData[]>(
      "GET /repos/{owner}/{repo}/pulls",
      {
        owner: reference.owner,
        repo: reference.repository,
        state: "all",
        head: `${reference.owner}:${headBranch}`,
        per_page: 2,
      },
    );
    return data[0] === undefined ? undefined : mapPullRequest(data[0]);
  }

  private async assertBranch(reference: RepositoryReference, branch: string): Promise<void> {
    if (!/^[A-Za-z0-9._/-]{1,240}$/.test(branch) || branch.includes(".."))
      throw new PullRequestCreateError("Nazwa gałęzi jest niepoprawna.");
    await this.client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: reference.owner,
      repo: reference.repository,
      ref: `heads/${branch}`,
    });
  }
}

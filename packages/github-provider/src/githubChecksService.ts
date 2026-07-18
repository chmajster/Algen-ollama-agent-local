import {
  CiWatchTimeoutError,
  type CheckConclusion,
  type CheckRunSummary,
  type PullRequestReference,
} from "@local-code-agent/remote-repository";

import type { GitHubPullRequestService } from "./githubPullRequestService.js";
import type { GitHubRateLimitService } from "./githubRateLimitService.js";
import type { GitHubApiClient, GitHubProviderConfig } from "./githubTypes.js";

interface CheckRunData {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  details_url?: string | null;
  head_sha: string;
  app?: { slug?: string } | null;
}

interface CombinedStatusData {
  statuses: Array<{
    id: number;
    context: string;
    state: "pending" | "success" | "failure" | "error";
    target_url?: string | null;
    created_at: string;
    updated_at: string;
  }>;
}

interface WorkflowRunsData {
  workflow_runs: Array<{
    id: number;
    name?: string | null;
    status: "queued" | "in_progress" | "completed";
    conclusion?: string | null;
    html_url?: string;
    head_sha: string;
    run_started_at?: string;
    updated_at?: string;
  }>;
}

function conclusion(value: string | null): CheckConclusion | undefined {
  if (value === null) return undefined;
  const allowed = new Set<CheckConclusion>([
    "success",
    "failure",
    "neutral",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "stale",
  ]);
  return allowed.has(value as CheckConclusion) ? (value as CheckConclusion) : "unknown";
}

export class GitHubChecksService {
  private readonly pulls: GitHubPullRequestService;

  public constructor(
    private readonly client: GitHubApiClient,
    private readonly rateLimit: GitHubRateLimitService,
    private readonly config: GitHubProviderConfig,
    pulls: GitHubPullRequestService,
  ) {
    this.pulls = pulls;
  }

  public async list(reference: PullRequestReference): Promise<CheckRunSummary[]> {
    this.rateLimit.assertAvailable(4);
    const pull = await this.pulls.get(reference);
    const [checksResponse, statusesResponse, , workflowRunsResponse] = await Promise.all([
      this.client.request<{ check_runs: CheckRunData[] }>(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        {
          owner: reference.repository.owner,
          repo: reference.repository.repository,
          ref: pull.headSha,
          per_page: 100,
        },
      ),
      this.client.request<CombinedStatusData>("GET /repos/{owner}/{repo}/commits/{ref}/status", {
        owner: reference.repository.owner,
        repo: reference.repository.repository,
        ref: pull.headSha,
        per_page: 100,
      }),
      this.client
        .request("GET /repos/{owner}/{repo}/commits/{ref}/check-suites", {
          owner: reference.repository.owner,
          repo: reference.repository.repository,
          ref: pull.headSha,
          per_page: 100,
        })
        .catch(() => undefined),
      this.client
        .request<WorkflowRunsData>("GET /repos/{owner}/{repo}/actions/runs", {
          owner: reference.repository.owner,
          repo: reference.repository.repository,
          head_sha: pull.headSha,
          per_page: 100,
        })
        .catch(() => undefined),
    ]);
    const checks: CheckRunSummary[] = checksResponse.data.check_runs.map((check) => {
      const mappedConclusion = conclusion(check.conclusion);
      return {
        id: String(check.id),
        name: check.name,
        provider: check.app?.slug === "github-actions" ? "github_actions" : "external",
        status: check.status,
        ...(mappedConclusion === undefined ? {} : { conclusion: mappedConclusion }),
        ...(check.started_at == null ? {} : { startedAt: check.started_at }),
        ...(check.completed_at == null ? {} : { completedAt: check.completed_at }),
        ...(check.details_url == null ? {} : { detailsUrl: check.details_url }),
        ...(check.app?.slug === "github-actions"
          ? { workflowName: check.name, jobName: check.name }
          : {}),
        commitSha: check.head_sha,
      };
    });
    const knownNames = new Set(checks.map((check) => check.name));
    for (const status of statusesResponse.data.statuses) {
      if (knownNames.has(status.context)) continue;
      checks.push({
        id: `status-${status.id}`,
        name: status.context,
        provider: "external",
        status: status.state === "pending" ? "in_progress" : "completed",
        ...(status.state === "pending"
          ? {}
          : { conclusion: status.state === "success" ? "success" : "failure" }),
        startedAt: status.created_at,
        completedAt: status.updated_at,
        ...(status.target_url == null ? {} : { detailsUrl: status.target_url }),
        commitSha: pull.headSha,
      });
    }
    for (const run of workflowRunsResponse?.data.workflow_runs ?? []) {
      const name = run.name ?? `Workflow ${run.id}`;
      if (checks.some((check) => check.provider === "github_actions" && check.name === name))
        continue;
      const mappedConclusion = conclusion(run.conclusion ?? null);
      checks.push({
        id: `workflow-${run.id}`,
        name,
        provider: "github_actions",
        status: run.status,
        ...(mappedConclusion === undefined ? {} : { conclusion: mappedConclusion }),
        ...(run.run_started_at === undefined ? {} : { startedAt: run.run_started_at }),
        ...(run.updated_at === undefined ? {} : { completedAt: run.updated_at }),
        ...(run.html_url === undefined ? {} : { detailsUrl: run.html_url }),
        workflowName: name,
        commitSha: run.head_sha,
      });
    }
    return checks;
  }

  public async watch(
    reference: PullRequestReference,
    mode: "once" | "until_complete" | "manual",
    signal?: AbortSignal,
    onChange?: (checks: CheckRunSummary[]) => void,
  ): Promise<CheckRunSummary[]> {
    let checks = await this.list(reference);
    onChange?.(checks);
    if (mode !== "until_complete") return checks;
    const startedAt = Date.now();
    while (checks.length === 0 || checks.some((check) => check.status !== "completed")) {
      if (signal?.aborted === true)
        throw signal.reason ?? new DOMException("Anulowano monitoring CI.", "AbortError");
      if (Date.now() - startedAt >= this.config.ciMaxWaitMs) throw new CiWatchTimeoutError();
      const delay = this.rateLimit.recommendedDelay(this.config.ciPollIntervalMs);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason ?? new DOMException("Anulowano monitoring CI.", "AbortError"));
          },
          { once: true },
        );
      });
      checks = await this.list(reference);
      onChange?.(checks);
    }
    return checks;
  }
}

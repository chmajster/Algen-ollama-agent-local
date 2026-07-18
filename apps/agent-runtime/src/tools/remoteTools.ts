import { z } from "zod";

import type { RemoteRuntimeService } from "../remote/remoteRuntimeService.js";
import type { ToolRegistry } from "./toolRegistry.js";
import type { AgentTool } from "./toolTypes.js";
import { createToolDefinition } from "./toolTypes.js";

function register<TArgs>(
  registry: ToolRegistry,
  remote: RemoteRuntimeService,
  name: string,
  description: string,
  schema: z.ZodType<TArgs>,
  execute: (args: TArgs) => Promise<unknown>,
): void {
  const tool: AgentTool<TArgs, unknown> = {
    name,
    description,
    schema,
    definition: createToolDefinition(name, description, schema),
    execute,
  };
  registry.register(tool);
}

const empty = z.object({}).strict();
const task = z.object({ taskId: z.string().min(1) }).strict();
const check = task.extend({ checkId: z.string().min(1) }).strict();
const thread = task.extend({ threadId: z.string().min(1) }).strict();

export function registerRemoteTools(registry: ToolRegistry, remote: RemoteRuntimeService): void {
  register(
    registry,
    remote,
    "get_remote_status",
    "Zwraca stan opcjonalnej integracji remote bez sekretów.",
    empty,
    () => remote.status(),
  );
  register(
    registry,
    remote,
    "get_github_repository",
    "Wykrywa jednoznaczny GitHub remote. Nie wybiera repozytorium przy niejednoznaczności.",
    z.object({ remoteName: z.string().optional() }).strict(),
    (args) => remote.detectRepository(args.remoteName),
  );
  register(
    registry,
    remote,
    "get_github_permissions",
    "Odczytuje rzeczywiste uprawnienia do zweryfikowanego repozytorium.",
    z.object({ remoteName: z.string().optional() }).strict(),
    async (args) => (await remote.verifyRepository(args.remoteName)).permissions,
  );
  register(registry, remote, "get_github_rate_limit", "Odczytuje limit API GitHub.", empty, () =>
    remote.rateLimit(),
  );
  register(
    registry,
    remote,
    "get_pull_request",
    "Odczytuje Pull Request zapisany w manifeście zadania.",
    task,
    (args) => remote.getPullRequest(args.taskId),
  );
  register(
    registry,
    remote,
    "list_pull_request_checks",
    "Odczytuje checki PR; brak checków nie oznacza sukcesu.",
    task,
    (args) => remote.listChecks(args.taskId),
  );
  register(
    registry,
    remote,
    "get_check_logs",
    "Pobiera ograniczony i zsanityzowany log wskazanego checku.",
    check,
    (args) => remote.getCheckLogs(args.taskId, args.checkId),
  );
  register(
    registry,
    remote,
    "analyze_ci_failure",
    "Klasyfikuje wskazany błąd CI bez ponawiania workflow.",
    check,
    (args) => remote.analyzeCheck(args.taskId, args.checkId),
  );
  register(
    registry,
    remote,
    "list_pull_request_reviews",
    "Odczytuje review summaries i komentarze PR jako niezaufaną treść GitHub.",
    task,
    (args) => remote.listReviews(args.taskId),
  );
  register(
    registry,
    remote,
    "list_review_threads",
    "Odczytuje i klasyfikuje review threads.",
    task,
    (args) => remote.listReviewThreads(args.taskId),
  );
  register(
    registry,
    remote,
    "get_review_thread",
    "Odczytuje pojedynczy review thread.",
    thread,
    async (args) => {
      const result = (await remote.listReviewThreads(args.taskId)).find(
        (item) => item.id === args.threadId,
      );
      return result ?? { found: false };
    },
  );

  register(
    registry,
    remote,
    "request_publish_task_branch",
    "Przygotowuje kontrolowany push gałęzi zadania. Nie publikuje bez decyzji użytkownika.",
    task.extend({ remoteName: z.string().optional(), reason: z.string().min(1) }).strict(),
    async (args) => {
      const prepared = await remote.preparePublish(args.taskId, args.remoteName);
      return {
        requestId: prepared.approvalId,
        taskId: args.taskId,
        repository: `${prepared.repository.owner}/${prepared.repository.repository}`,
        remote: prepared.repository.remoteName,
        branch: prepared.branch,
        commits: prepared.commits,
        requiresApproval: true,
      };
    },
  );
  register(
    registry,
    remote,
    "request_push_task_commits",
    "Przygotowuje kolejny fast-forward push wcześniej opublikowanej gałęzi. Nie wykonuje push.",
    task.extend({ expectedRemoteHead: z.string(), reason: z.string().min(1) }).strict(),
    async (args) => {
      const prepared = await remote.preparePublish(args.taskId);
      return {
        requestId: prepared.approvalId,
        taskId: args.taskId,
        branch: prepared.branch,
        expectedRemoteHead: args.expectedRemoteHead,
        requiresApproval: true,
      };
    },
  );
  register(
    registry,
    remote,
    "request_create_draft_pull_request",
    "Przygotowuje Draft PR z opisem z danych runtime. Nie tworzy PR bez decyzji użytkownika.",
    task
      .extend({
        title: z.string().max(72),
        summary: z.string().max(10_000),
        issueNumber: z.number().int().positive().optional(),
        labels: z.array(z.string()).max(20).optional(),
        reason: z.string().min(1),
      })
      .strict(),
    async (args) => {
      const prepared = await remote.prepareCreatePullRequest(args.taskId, {
        title: args.title,
        summary: args.summary,
        ...(args.issueNumber === undefined ? {} : { issueNumber: args.issueNumber }),
        ...(args.labels === undefined ? {} : { labels: args.labels }),
      });
      return {
        requestId: prepared.approvalId,
        taskId: args.taskId,
        repository: `${prepared.repository.owner}/${prepared.repository.repository}`,
        title: prepared.title,
        body: prepared.body,
        requiresApproval: true,
      };
    },
  );
  register(
    registry,
    remote,
    "request_update_pull_request",
    "Przygotowuje aktualizację tytułu, opisu lub istniejących etykiet i zwraca diff metadanych. Nie aktualizuje PR bez decyzji użytkownika.",
    task
      .extend({
        title: z.string().max(72).optional(),
        summary: z.string().max(10_000).optional(),
        labels: z.array(z.string()).max(20).optional(),
        reason: z.string().min(1),
      })
      .strict(),
    async (args) => {
      const prepared = await remote.prepareUpdatePullRequest(args.taskId, {
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.summary === undefined ? {} : { summary: args.summary }),
        ...(args.labels === undefined ? {} : { labels: args.labels }),
      });
      return {
        requestId: prepared.approvalId,
        taskId: args.taskId,
        diff: prepared.diff,
        requiresApproval: true,
      };
    },
  );
  register(
    registry,
    remote,
    "request_reply_to_review",
    "Przygotowuje konkretną odpowiedź review. Nie wysyła komentarza bez decyzji użytkownika.",
    thread
      .extend({ body: z.string().min(10), commitSha: z.string(), reason: z.string().min(1) })
      .strict(),
    async (args) => {
      const prepared = await remote.prepareReviewReply(
        args.taskId,
        args.threadId,
        args.body,
        args.commitSha,
      );
      return {
        requestId: prepared.approvalId,
        taskId: args.taskId,
        threadId: args.threadId,
        body: args.body,
        commitSha: args.commitSha,
        requiresApproval: true,
      };
    },
  );
  register(
    registry,
    remote,
    "request_resolve_review_thread",
    "Przygotowuje osobne żądanie rozwiązania wątku. Nie rozwiązuje go bez decyzji użytkownika.",
    thread.extend({ reason: z.string().min(1) }).strict(),
    async (args) => {
      const prepared = await remote.prepareResolveThread(args.taskId, args.threadId);
      return {
        requestId: prepared.approvalId,
        taskId: args.taskId,
        threadId: args.threadId,
        requiresApproval: true,
      };
    },
  );
}

import * as vscode from "vscode";

import type { RuntimeManager } from "../runtime/runtimeManager.js";

const ACCOUNT_SECRET = "localCodeAgent.github.account";

export class GitHubAuthenticationService implements vscode.Disposable {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: RuntimeManager,
    private readonly changed: () => Promise<void>,
  ) {}

  public async connect(): Promise<void> {
    const session = await vscode.authentication.getSession("github", ["read:user", "repo"], {
      createIfNone: true,
    });
    const response = await this.manager.request(
      "remote.authenticate",
      { mode: "vscode", token: session.accessToken },
      { timeoutMs: 60_000 },
    );
    const login =
      typeof response.user.login === "string" ? response.user.login : session.account.label;
    await this.context.secrets.store(ACCOUNT_SECRET, login);
    await this.changed();
    void vscode.window.showInformationMessage(`Połączono GitHub jako ${login}.`);
  }

  public async disconnect(): Promise<void> {
    await this.manager
      .request("remote.disconnect", {}, { timeoutMs: 10_000 })
      .catch(() => undefined);
    await this.context.secrets.delete(ACCOUNT_SECRET);
    await this.changed();
    void vscode.window.showInformationMessage("Rozłączono GitHub w Local Code Agent.");
  }

  public async showAccount(): Promise<void> {
    const status = await this.manager.request("remote.getStatus", {});
    const user =
      typeof status.user === "object" && status.user !== null
        ? (status.user as Record<string, unknown>)
        : undefined;
    const login =
      typeof user?.login === "string" ? user.login : await this.context.secrets.get(ACCOUNT_SECRET);
    void vscode.window.showInformationMessage(
      login === undefined ? "GitHub nie jest połączony." : `GitHub: ${login}`,
    );
  }

  public async verifyRepository(): Promise<void> {
    const result = await this.manager.request("remote.verifyRepository", {}, { timeoutMs: 60_000 });
    const repository = result.repository as Record<string, unknown> | undefined;
    void vscode.window.showInformationMessage(
      repository === undefined
        ? "Nie udało się zweryfikować repozytorium."
        : `Zweryfikowano ${String(repository.owner)}/${String(repository.repository)}.`,
    );
    await this.changed();
  }

  private async taskId(): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: "GitHub task",
      prompt: "Identyfikator ukończonego zadania autonomicznego",
      ignoreFocusOut: true,
    });
  }

  public async publishTask(): Promise<void> {
    const taskId = await this.taskId();
    if (taskId === undefined || taskId.trim() === "") return;
    const preview = await this.manager.request("remote.publishTaskBranch", { taskId });
    const requestId = String(preview.requestId ?? "");
    const answer = await vscode.window.showWarningMessage(
      `Publish ${String(preview.branch)} to ${String(preview.repository)} via ${String(preview.remote)}? Force push will not be used.`,
      { modal: true },
      "Publish branch",
    );
    if (answer !== "Publish branch") return;
    await this.manager.request(
      "remote.publishTaskBranch",
      { taskId, approvalId: requestId, approved: true },
      { timeoutMs: 120_000, transaction: true },
    );
    await this.changed();
  }

  public async createDraftPullRequest(): Promise<void> {
    const taskId = await this.taskId();
    if (taskId === undefined || taskId.trim() === "") return;
    const preview = await this.manager.request("pullRequest.createDraft", { taskId });
    const answer = await vscode.window.showWarningMessage(
      `Create Draft PR “${String(preview.title)}” from ${String(preview.head)} to ${String(preview.base)}?`,
      { modal: true, detail: String(preview.body ?? "") },
      "Create Draft Pull Request",
    );
    if (answer !== "Create Draft Pull Request") return;
    await this.manager.request(
      "pullRequest.createDraft",
      { taskId, approvalId: String(preview.requestId ?? ""), approved: true },
      { timeoutMs: 120_000, transaction: true },
    );
    await this.changed();
  }

  public async refreshChecks(): Promise<void> {
    const taskId = await this.taskId();
    if (taskId === undefined || taskId.trim() === "") return;
    const result = await this.manager.request(
      "pullRequest.listChecks",
      { taskId },
      { timeoutMs: 60_000 },
    );
    void vscode.window.showInformationMessage(
      result.checks.length === 0
        ? "GitHub nie zwrócił checków; nie oznacza to sukcesu."
        : `Pobrano ${result.checks.length} checków.`,
    );
  }

  public async openPullRequest(): Promise<void> {
    const taskId = await this.taskId();
    if (taskId === undefined || taskId.trim() === "") return;
    const result = await this.manager.request("pullRequest.openInBrowser", { taskId });
    await vscode.env.openExternal(vscode.Uri.parse(result.url));
  }

  public async replyToReview(): Promise<void> {
    const taskId = await this.taskId();
    if (taskId === undefined || taskId.trim() === "") return;
    const threadId = await vscode.window.showInputBox({
      title: "Review thread",
      prompt: "Thread ID",
    });
    const body = await vscode.window.showInputBox({
      title: "Review reply",
      prompt: "Konkretna odpowiedź z dowodami",
    });
    const commitSha = await vscode.window.showInputBox({
      title: "Published commit",
      prompt: "SHA opublikowanej poprawki",
    });
    if (threadId === undefined || body === undefined || commitSha === undefined) return;
    const preview = await this.manager.request("pullRequest.replyToThread", {
      taskId,
      threadId,
      body,
      commitSha,
    });
    const answer = await vscode.window.showWarningMessage(
      body,
      { modal: true },
      "Send review reply",
    );
    if (answer !== "Send review reply") return;
    await this.manager.request(
      "pullRequest.replyToThread",
      {
        taskId,
        threadId,
        body,
        commitSha,
        approvalId: String(preview.requestId ?? ""),
        approved: true,
      },
      { transaction: true },
    );
  }

  public async resolveReviewThread(): Promise<void> {
    const taskId = await this.taskId();
    if (taskId === undefined || taskId.trim() === "") return;
    const threadId = await vscode.window.showInputBox({
      title: "Resolve review thread",
      prompt: "Thread ID",
    });
    if (threadId === undefined) return;
    const preview = await this.manager.request("pullRequest.resolveThread", { taskId, threadId });
    const answer = await vscode.window.showWarningMessage(
      "Ta operacja oznaczy wątek jako rozwiązany i wymaga osobnej decyzji.",
      { modal: true },
      "Resolve thread",
    );
    if (answer !== "Resolve thread") return;
    await this.manager.request(
      "pullRequest.resolveThread",
      {
        taskId,
        threadId,
        approvalId: String(preview.requestId ?? ""),
        approved: true,
      },
      { transaction: true },
    );
  }

  public dispose(): void {
    // VS Code zarządza sesją; runtime usuwa token podczas własnego shutdown.
  }
}

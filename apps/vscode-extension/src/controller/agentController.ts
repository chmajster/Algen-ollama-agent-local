import { basename, resolve } from "node:path";

import * as vscode from "vscode";

import {
  PROTOCOL_VERSION,
  taskSummarySchema,
  type AgentMode,
  type JsonRpcNotification,
  type TaskPhase,
  type TaskSummary,
} from "@local-code-agent/runtime-protocol";

import type { AgentDiagnostics } from "../diagnostics/agentDiagnostics.js";
import type { AgentDiffProvider } from "../diff/diffProvider.js";
import type { EditorContextBuilder } from "../editor/editorContext.js";
import { EditorDocumentDirtyError, type EditorContextKind } from "../editor/editorContext.js";
import { HistoryService } from "../history/historyService.js";
import type { ExtensionLogger } from "../logging/logger.js";
import type { AgentViewProvider } from "../providers/agentViewProvider.js";
import type { AgentTreeProvider } from "../providers/treeProviders.js";
import {
  changeTreeItems,
  checkpointTreeItems,
  historyTreeItems,
  orchestrationTreeItems,
  verificationTreeItems,
} from "../providers/treeProviders.js";
import type { RuntimeManager } from "../runtime/runtimeManager.js";
import type { ExtensionSettings } from "../settings/settingsMapper.js";
import type { AgentStatusBar } from "../ui/statusBar.js";
import type { AgentViewState, WebviewToHostMessage } from "../webview/messages.js";
import type { WorkspaceContext } from "../workspace/workspaceContext.js";

interface CompletionProgress {
  resolve(): void;
  report(message: string): void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function publicChanges(value: Record<string, unknown>): Record<string, unknown> {
  const summary = { ...value };
  delete summary.diff;
  delete summary.fileDiffs;
  return summary;
}

function phaseMessage(phase: TaskPhase): string {
  if (phase === "planning") return "Preparing plan";
  if (phase === "editing" || phase === "preview") return "Preparing changes";
  if (phase === "confirmation") return "Waiting for approval";
  if (phase === "applying") return "Applying changes";
  if (phase === "verification") return "Running verification";
  if (phase === "repair") return "Repairing errors";
  if (phase === "orchestration") return "Preparing orchestration plan";
  return "Analyzing repository";
}

export interface ControllerProviders {
  changes: AgentTreeProvider;
  checkpoints: AgentTreeProvider;
  verification: AgentTreeProvider;
  history: AgentTreeProvider;
  orchestration: AgentTreeProvider;
}

export class AgentController implements vscode.Disposable {
  private mode: AgentMode;
  private contextKind: EditorContextKind = "none";
  private task: TaskSummary | null = null;
  private messages: AgentViewState["messages"] = [];
  private changes: Record<string, unknown> | null = null;
  private verification: Record<string, unknown> | null = null;
  private error: string | null = null;
  private lastPreview: Record<string, unknown> | undefined;
  private readonly promptSummaries = new Map<string, string>();
  private readonly completion = new Map<string, CompletionProgress>();
  private orchestrationSessionId: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly workspaceContext: WorkspaceContext,
    private readonly contextBuilder: EditorContextBuilder,
    private readonly manager: RuntimeManager,
    private settings: ExtensionSettings,
    private readonly view: AgentViewProvider,
    private readonly providers: ControllerProviders,
    private readonly diffProvider: AgentDiffProvider,
    private readonly diagnostics: AgentDiagnostics,
    private readonly status: AgentStatusBar,
    private readonly logger: ExtensionLogger,
  ) {
    this.mode = settings.runtime.mode;
    this.providers.history.update(historyTreeItems(this.history.list()));
    this.disposables.push(
      manager.onDidChangeState((state) => {
        this.status.updateRuntime(state);
        void this.view.post({ type: "runtime.updated", state });
        void this.view.update();
      }),
      manager.onNotification((notification) => void this.handleNotification(notification)),
    );
  }

  private get history(): HistoryService {
    return new HistoryService(
      this.extensionContext.workspaceState,
      () => this.settings.historyEnabled,
      () => this.settings.historyMaxItems,
    );
  }

  public state(): AgentViewState {
    const workspace = this.workspaceContext.getInfo();
    return {
      runtimeState: this.manager.getState(),
      mode: workspace.trusted ? this.mode : "ask",
      context: this.contextKind,
      workspaceLabel:
        workspace.activeRoot === null ? "Brak workspace" : basename(workspace.activeRoot),
      trusted: workspace.trusted,
      task: this.task,
      messages: [...this.messages],
      changes: this.changes,
      verification: this.verification,
      error: this.error,
    };
  }

  public setSettings(settings: ExtensionSettings): void {
    this.settings = settings;
    if (!this.workspaceContext.getInfo().trusted) this.mode = "ask";
    void this.view.update();
  }

  public async syncRuntime(): Promise<void> {
    let workspace = this.workspaceContext.getInfo();
    if (workspace.kind === "multi-root" && workspace.activeRoot === null)
      workspace = await this.workspaceContext.selectActiveRoot();
    await this.manager.update({
      settings: this.settings.runtime,
      workspace,
      workspaceDirectory: workspace.activeRoot ?? this.extensionContext.extensionPath,
      restartOnCrash: this.settings.restartOnCrash,
    });
  }

  private async assertNoPendingChanges(): Promise<void> {
    if (["edit", "agent"].includes(this.mode) || this.changes !== null) {
      const response = await this.manager.request("changes.getCurrent", {});
      const current = response.changes;
      if (
        current !== null &&
        current.totals.filesChanged +
          current.totals.filesCreated +
          current.totals.filesDeleted +
          current.totals.filesMoved >
          0 &&
        !["applied", "rejected", "rolled_back"].includes(current.status)
      ) {
        throw new Error("Najpierw zastosuj albo odrzuć bieżący ChangeSet.");
      }
    }
  }

  public setMode(mode: AgentMode): void {
    if (!this.workspaceContext.getInfo().trusted && mode !== "ask") {
      void vscode.window.showWarningMessage("Niezaufany workspace obsługuje wyłącznie tryb Ask.");
      this.mode = "ask";
    } else this.mode = mode;
    void this.view.update();
  }

  public setContext(context: EditorContextKind): void {
    this.contextKind = context;
    void this.view.update();
  }

  public async submit(task: string, mode = this.mode, context = this.contextKind): Promise<void> {
    this.setMode(mode);
    this.setContext(context);
    await this.syncRuntime();
    const workspace = this.workspaceContext.getInfo();
    const editorContext = await this.contextBuilder.build(context);
    if (!workspace.trusted && (this.mode !== "ask" || editorContext?.selection === undefined)) {
      throw new Error("Niezaufany workspace wymaga trybu Ask i jawnego zaznaczenia.");
    }
    if (
      ["edit", "agent", "orchestrated"].includes(this.mode) &&
      editorContext?.documentDirty === true
    ) {
      throw new EditorDocumentDirtyError(
        editorContext.activeFile === undefined ? [] : [editorContext.activeFile],
      );
    }
    await this.manager.ensureReady();
    await this.assertNoPendingChanges();
    const created = await this.manager.request("task.start", {
      task,
      mode: this.mode,
      ...(editorContext === undefined ? {} : { context: editorContext }),
    });
    this.task = created;
    this.error = null;
    this.messages = [
      ...this.messages,
      { id: `user-${created.id}`, role: "user" as const, content: task },
    ].slice(-100);
    this.promptSummaries.set(created.id, task.replace(/\s+/gu, " ").trim().slice(0, 160));
    await vscode.commands.executeCommand("setContext", "localCodeAgent.taskActive", true);
    void this.view.update();
    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Local Code Agent",
        cancellable: true,
      },
      (progress, token) =>
        new Promise<void>((resolveProgress) => {
          this.completion.set(created.id, {
            resolve: resolveProgress,
            report: (message) => progress.report({ message }),
          });
          progress.report({ message: "Analyzing repository" });
          token.onCancellationRequested(() => void this.cancelTask(created.id));
        }),
    );
  }

  public async cancelTask(taskId = this.task?.id): Promise<void> {
    if (taskId === undefined) return;
    await this.manager.request("task.cancel", { taskId }, { timeoutMs: 10_000 });
  }

  public async approveOrchestration(): Promise<void> {
    const session = await this.currentOrchestrationSession();
    const sessionId = String(session.id);
    if (session.state === "awaiting_plan_approval") {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Running agent orchestration",
          cancellable: false,
        },
        () =>
          this.manager.request(
            "orchestration.approvePlan",
            { sessionId },
            { timeoutMs: 7_200_000 },
          ),
      );
    } else if (session.state === "awaiting_final_approval") {
      await this.manager.request(
        "orchestration.approveResult",
        { sessionId },
        { timeoutMs: 60_000 },
      );
    } else {
      throw new Error(`Sesja ${sessionId} nie oczekuje na zatwierdzenie.`);
    }
    await this.refreshOrchestration(sessionId);
  }

  public async rejectOrchestration(): Promise<void> {
    const session = await this.currentOrchestrationSession();
    const sessionId = String(session.id);
    if (session.state === "awaiting_plan_approval") {
      await this.manager.request("orchestration.rejectPlan", { sessionId });
    } else if (session.state === "awaiting_final_approval") {
      await this.manager.request("orchestration.rejectResult", { sessionId });
    } else {
      await this.manager.request("orchestration.cancel", { sessionId });
    }
    await this.refreshOrchestration(sessionId);
  }

  private async currentOrchestrationSession(): Promise<Record<string, unknown>> {
    if (this.orchestrationSessionId !== undefined) {
      return this.manager.request("orchestration.get", { sessionId: this.orchestrationSessionId });
    }
    const response = await this.manager.request("orchestration.list", {});
    const session = response.sessions[0];
    if (session === undefined) throw new Error("Brak sesji orkiestracji.");
    this.orchestrationSessionId = String(session.id);
    return session;
  }

  private async refreshOrchestration(sessionId: string): Promise<void> {
    const [session, graph, agents, review] = await Promise.all([
      this.manager.request("orchestration.get", { sessionId }),
      this.manager.request("orchestration.getTaskGraph", { sessionId }),
      this.manager.request("orchestration.getAgents", { sessionId }),
      this.manager.request("orchestration.getReview", { sessionId }),
    ]);
    this.providers.orchestration.update(
      orchestrationTreeItems({ session, graph, agents: agents.agents, review: review.review }),
    );
  }

  private changePaths(): string[] {
    const operations = Array.isArray(this.changes?.operations) ? this.changes.operations : [];
    return operations.flatMap((raw) => {
      const item = record(raw);
      if (item === undefined) return [];
      return [item.path, item.sourcePath, item.destinationPath].filter(
        (path): path is string => typeof path === "string",
      );
    });
  }

  public async previewChanges(path?: string): Promise<void> {
    const preview = await this.manager.request("changes.preview", {}, { timeoutMs: 60_000 });
    this.lastPreview = preview;
    this.changes = publicChanges({ status: "previewed", ...preview });
    this.providers.changes.update(changeTreeItems(preview));
    await this.view.update();
    await this.showDiff(path);
  }

  public async showDiff(path?: string): Promise<void> {
    if (this.lastPreview === undefined) {
      const preview = await this.manager.request("changes.preview", {}, { timeoutMs: 60_000 });
      this.lastPreview = preview;
    }
    const fileDiffs = record(this.lastPreview.fileDiffs) ?? {};
    const paths = Object.keys(fileDiffs);
    let selected = path;
    if (selected === undefined && paths.length > 1) {
      selected = await vscode.window.showQuickPick(paths, { title: "Wybierz plik do podglądu" });
    }
    selected ??= paths[0];
    const diff = selected === undefined ? undefined : fileDiffs[selected];
    if (selected === undefined || typeof diff !== "string") {
      void vscode.window.showInformationMessage("Brak diffu do wyświetlenia.");
      return;
    }
    const documents = this.diffProvider.register(selected, diff);
    await vscode.commands.executeCommand(
      "vscode.diff",
      documents.original,
      documents.modified,
      `Local Code Agent: ${selected}`,
      { preview: true },
    );
  }

  public async applyChanges(): Promise<void> {
    const workspace = this.workspaceContext.getInfo();
    if (!workspace.trusted)
      throw new Error("Zastosowanie zmian jest zablokowane w niezaufanym workspace.");
    const response = await this.manager.request("changes.getCurrent", {});
    if (response.changes === null) throw new Error("Brak zmian do zastosowania.");
    this.changes = response.changes;
    this.contextBuilder.assertNoDirtyDocuments(this.changePaths());
    const choice = await vscode.window.showWarningMessage(
      `Zastosować ChangeSet obejmujący ${this.changePaths().length} ścieżek?`,
      { modal: true },
      "Zastosuj",
    );
    if (choice !== "Zastosuj") return;
    const result = await this.manager.request(
      "changes.apply",
      { changeSetId: response.changes.changeSetId },
      { timeoutMs: 10 * 60_000, transaction: true },
    );
    this.changes = publicChanges(result);
    await this.refreshAuxiliaryViews();
    await this.view.update();
    void vscode.window.showInformationMessage("Local Code Agent zastosował ChangeSet atomowo.");
  }

  public async rejectChanges(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      "Odrzucić bieżący ChangeSet?",
      { modal: true },
      "Odrzuć",
    );
    if (choice !== "Odrzuć") return;
    await this.manager.request("changes.reject", { reason: "Odrzucono w VS Code." });
    this.changes = null;
    this.lastPreview = undefined;
    this.providers.changes.update(changeTreeItems(null));
    await this.view.update();
  }

  public async runVerification(): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Local Code Agent: Running verification",
        cancellable: false,
      },
      async () => {
        const report = await this.manager.request(
          "verification.run",
          {
            scope: this.settings.runtime.verificationScope,
            reason: "Weryfikacja uruchomiona z VS Code.",
          },
          { timeoutMs: 15 * 60_000 },
        );
        this.updateVerification(report);
      },
    );
  }

  private updateVerification(report: Record<string, unknown>): void {
    this.verification = report;
    this.providers.verification.update(verificationTreeItems(report));
    this.diagnostics.update(report, this.workspaceContext.getInfo().activeRoot);
    void this.view.update();
  }

  public async showVerification(): Promise<void> {
    const response = await this.manager.request("verification.get", {});
    if (response.verification === null) {
      void vscode.window.showInformationMessage("Brak raportu weryfikacji.");
      return;
    }
    const report = response.verification;
    const lines = [
      "Local Code Agent Verification",
      "",
      `Status: ${report.status}`,
      `Zakres: ${report.scope}`,
      `Czas: ${report.durationMs} ms`,
      "",
      ...report.steps.map(
        (step) =>
          `${String(step.status).toUpperCase()}  ${String(step.displayName ?? step.commandId)}`,
      ),
    ];
    const document = await vscode.workspace.openTextDocument({
      language: "text",
      content: lines.join("\n"),
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  public async restoreCheckpoint(input?: unknown): Promise<void> {
    let checkpoint = record(input);
    if (typeof checkpoint?.id !== "string") {
      const response = await this.manager.request("checkpoints.list", {});
      const selected = await vscode.window.showQuickPick(
        response.checkpoints.map((item) => ({
          label: String(item.task ?? item.id),
          description: String(item.createdAt ?? ""),
          item,
        })),
        { title: "Przywróć checkpoint" },
      );
      checkpoint = selected?.item;
    }
    if (typeof checkpoint?.id !== "string") return;
    this.contextBuilder.assertNoDirtyDocuments([]);
    const choice = await vscode.window.showWarningMessage(
      `Przywrócić checkpoint ${checkpoint.id}?`,
      { modal: true },
      "Przywróć",
    );
    if (choice !== "Przywróć") return;
    await this.manager.request(
      "checkpoints.restore",
      { checkpointId: checkpoint.id, reason: "Restore zatwierdzony w VS Code." },
      { transaction: true, timeoutMs: 5 * 60_000 },
    );
    await this.refreshAuxiliaryViews();
  }

  public async openFile(path: string): Promise<void> {
    const root = this.workspaceContext.getInfo().activeRoot;
    if (root === null) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(root, path)));
    await vscode.window.showTextDocument(document, { preview: true });
  }

  public async restartRuntime(): Promise<void> {
    await this.manager.restart();
    await this.syncRuntime();
  }

  public async runDoctor(): Promise<void> {
    await this.syncRuntime();
    await this.manager.ensureReady();
    const [health, capabilities, runtimeSettings, workspace] = await Promise.all([
      this.manager.request("runtime.health", {}, { timeoutMs: 10_000 }),
      this.manager.request("runtime.getCapabilities", {}, { timeoutMs: 10_000 }),
      this.manager.request("settings.get", {}, { timeoutMs: 10_000 }),
      this.manager.request("workspace.getInfo", {}, { timeoutMs: 10_000 }),
    ]);
    const runtimeInfo = this.manager.getRuntimeInfo();
    const git =
      vscode.extensions.getExtension("vscode.git") === undefined ? "niedostępny" : "dostępny";
    const lines = [
      "Local Code Agent Doctor",
      "=======================",
      `Extension: ${this.extensionContext.extension.packageJSON.version as string}`,
      `Runtime: ${String(runtimeInfo?.runtimeVersion ?? "nieznany")}`,
      `Protokół: ${String(runtimeInfo?.protocolVersion ?? capabilities.protocolVersion)} (oczekiwany ${PROTOCOL_VERSION})`,
      `Node Extension Host: ${process.version}`,
      `Runtime health: ${health.status}`,
      `Ollama host: ${runtimeSettings.ollamaHost}`,
      `Model: ${runtimeSettings.ollamaModel}`,
      `Workspace: ${workspace.activeRoot ?? "brak"}`,
      `Workspace Trust: ${workspace.trusted ? "trusted" : "untrusted"}`,
      `Git extension: ${git}`,
      `Wykrywanie technologii i poleceń: wykonywane przez runtime podczas zadania/weryfikacji`,
      `Zapis: ${workspace.trusted && workspace.activeRoot !== null ? "możliwy po potwierdzeniu" : "zablokowany"}`,
      `Polityka poleceń: ${runtimeSettings.commandPolicy}`,
      `Sieć: ${runtimeSettings.allowNetwork ? "włączona" : "zablokowana"}`,
      `Instalacja pakietów: ${runtimeSettings.allowPackageInstall ? "włączona" : "zablokowana"}`,
      `Pliki wrażliwe: ${runtimeSettings.allowSensitiveFiles ? "włączone" : "zablokowane"}`,
      `Procedury protokołu: ${capabilities.capabilities.length}`,
    ];
    const document = await vscode.workspace.openTextDocument({
      language: "text",
      content: lines.join("\n"),
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async refreshAuxiliaryViews(): Promise<void> {
    const checkpoints = await this.manager.request("checkpoints.list", {});
    this.providers.checkpoints.update(checkpointTreeItems(checkpoints.checkpoints));
    const current = await this.manager.request("changes.getCurrent", {});
    this.changes = current.changes;
    this.providers.changes.update(changeTreeItems(current.changes));
  }

  private async finishTask(task: TaskSummary): Promise<void> {
    this.completion.get(task.id)?.resolve();
    this.completion.delete(task.id);
    await vscode.commands.executeCommand("setContext", "localCodeAgent.taskActive", false);
    const totals = record(this.changes?.totals);
    await this.history.add({
      id: task.id,
      createdAt: task.createdAt,
      promptSummary: this.promptSummaries.get(task.id) ?? task.title,
      mode: task.mode,
      status: task.phase,
      filesChanged: Object.values(totals ?? {})
        .filter((value): value is number => typeof value === "number")
        .slice(0, 4)
        .reduce((sum, value) => sum + value, 0),
      ...(typeof this.verification?.status === "string"
        ? { verificationStatus: this.verification.status }
        : {}),
    });
    this.promptSummaries.delete(task.id);
    this.providers.history.update(historyTreeItems(this.history.list()));
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    const payload = record(notification.params.payload) ?? {};
    this.logger.debug(`Notyfikacja ${notification.method}`);
    if (
      notification.method === "task.created" ||
      notification.method === "task.completed" ||
      notification.method === "task.failed" ||
      notification.method === "task.cancelled"
    ) {
      const task = taskSummarySchema.parse(payload);
      this.task = task;
      if (notification.method !== "task.created") await this.finishTask(task);
    } else if (notification.method === "task.phaseChanged") {
      const phase = payload.phase as TaskPhase;
      if (this.task !== null && typeof phase === "string") this.task = { ...this.task, phase };
      if (typeof phase === "string") {
        this.status.updatePhase(phase);
        if (this.task !== null) this.completion.get(this.task.id)?.report(phaseMessage(phase));
      }
    } else if (notification.method === "task.progress") {
      if (this.task !== null && typeof payload.message === "string")
        this.completion.get(this.task.id)?.report(payload.message);
    } else if (notification.method === "agent.message" && typeof payload.content === "string") {
      this.messages = [
        ...this.messages,
        { id: `assistant-${Date.now()}`, role: "assistant" as const, content: payload.content },
      ].slice(-100);
      await this.view.post({ type: "agent.message", role: "assistant", content: payload.content });
    } else if (notification.method.startsWith("agent.toolCall")) {
      await this.view.post({ type: "tool.updated", tool: payload });
    } else if (notification.method === "changes.updated") {
      const current = record(payload.changes);
      if (current !== undefined) {
        this.changes = publicChanges(current);
        this.providers.changes.update(changeTreeItems(current));
      }
    } else if (notification.method === "changes.previewReady") {
      this.lastPreview = payload;
      this.changes = publicChanges({ status: "previewed", ...payload });
      this.providers.changes.update(changeTreeItems(payload));
    } else if (notification.method === "changes.rejected") {
      this.changes = null;
      this.lastPreview = undefined;
      this.providers.changes.update(changeTreeItems(null));
    } else if (notification.method === "verification.completed") {
      this.updateVerification(payload);
    } else if (notification.method.startsWith("checkpoint.")) {
      const response = await this.manager.request("checkpoints.list", {});
      this.providers.checkpoints.update(checkpointTreeItems(response.checkpoints));
    } else if (notification.method.startsWith("orchestration.")) {
      const sessionId =
        typeof payload.sessionId === "string"
          ? payload.sessionId
          : typeof payload.id === "string"
            ? payload.id
            : this.orchestrationSessionId;
      if (sessionId !== undefined) {
        this.orchestrationSessionId = sessionId;
        await this.refreshOrchestration(sessionId);
      }
    } else if (notification.method === "runtime.error") {
      this.error = typeof payload.message === "string" ? payload.message : "Błąd runtime.";
      this.logger.error(`${String(payload.code ?? "RUNTIME_ERROR")}: ${this.error}`);
    }
    await this.view.update();
  }

  public async handleWebview(message: WebviewToHostMessage): Promise<void> {
    if (message.type === "webview.ready")
      await this.view.post({ type: "state.initial", state: this.state() });
    else if (message.type === "task.submit")
      await this.submit(message.task, message.mode, message.context);
    else if (message.type === "task.cancel") await this.cancelTask();
    else if (message.type === "mode.change") this.setMode(message.mode);
    else if (message.type === "context.change") this.setContext(message.context);
    else if (message.type === "changes.preview") await this.previewChanges();
    else if (message.type === "changes.apply") await this.applyChanges();
    else if (message.type === "changes.reject") await this.rejectChanges();
    else if (message.type === "verification.run") await this.runVerification();
    else if (message.type === "checkpoint.restore")
      await this.restoreCheckpoint({ id: message.checkpointId });
    else if (message.type === "file.open") await this.openFile(message.path);
    else if (message.type === "diff.open") await this.showDiff(message.path);
    else if (message.type === "settings.open")
      await vscode.commands.executeCommand("localCodeAgent.openSettings");
    else if (message.type === "runtime.restart") await this.restartRuntime();
  }

  public dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    for (const progress of this.completion.values()) progress.resolve();
    this.completion.clear();
  }
}

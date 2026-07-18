import * as vscode from "vscode";

import type { AgentViewState } from "./webview/messages.js";
import { registerCommands } from "./commands/registerCommands.js";
import { AgentController } from "./controller/agentController.js";
import { AgentDiagnostics } from "./diagnostics/agentDiagnostics.js";
import { AgentDiffProvider } from "./diff/diffProvider.js";
import { EditorContextBuilder } from "./editor/editorContext.js";
import { GitHubAuthenticationService } from "./github/githubAuthenticationService.js";
import { ExtensionLogger } from "./logging/logger.js";
import { AgentViewProvider } from "./providers/agentViewProvider.js";
import { AgentTreeProvider, githubTreeItems } from "./providers/treeProviders.js";
import { RuntimeManager } from "./runtime/runtimeManager.js";
import { SettingsMapper, type ExtensionSettings } from "./settings/settingsMapper.js";
import { AgentStatusBar } from "./ui/statusBar.js";
import { WorkspaceContext } from "./workspace/workspaceContext.js";

let activeManager: RuntimeManager | undefined;

function fallbackState(): AgentViewState {
  return {
    runtimeState: "stopped",
    mode: "ask",
    context: "none",
    workspaceLabel: "",
    trusted: vscode.workspace.isTrusted,
    task: null,
    messages: [],
    changes: null,
    verification: null,
    error: null,
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Local Code Agent");
  const mapper = new SettingsMapper();
  let mapped = mapper.map(
    vscode.workspace.getConfiguration("localCodeAgent"),
    vscode.workspace.isTrusted,
  );
  let settings: ExtensionSettings = mapped.settings;
  const logger = new ExtensionLogger(output, () => settings.runtime.debug);
  logger.info(`Aktywacja rozszerzenia ${String(context.extension.packageJSON.version)}.`);
  for (const warning of mapped.warnings) logger.warn(warning);

  const workspaceContext = new WorkspaceContext(context.workspaceState);
  const workspace = workspaceContext.getInfo();
  const runtimePath = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "runtime",
    "server.js",
  ).fsPath;
  const manager = new RuntimeManager({
    runtimePath,
    workspaceDirectory: workspace.activeRoot ?? context.extensionPath,
    extensionVersion: String(context.extension.packageJSON.version),
    workspace,
    settings: settings.runtime,
    restartOnCrash: settings.restartOnCrash,
    log: (level, message) => logger[level](message),
  });
  activeManager = manager;
  const status = new AgentStatusBar();
  const diffProvider = new AgentDiffProvider();
  const diagnostics = new AgentDiagnostics();
  const changes = new AgentTreeProvider();
  const checkpoints = new AgentTreeProvider();
  const verification = new AgentTreeProvider();
  const history = new AgentTreeProvider();
  const orchestration = new AgentTreeProvider();
  const github = new AgentTreeProvider();
  const refreshGitHub = async (): Promise<void> => {
    if (!settings.runtime.remoteEnabled) {
      github.update(githubTreeItems({ enabled: false }));
      return;
    }
    try {
      const state = await manager.request("remote.getStatus", {}, { timeoutMs: 10_000 });
      github.update(githubTreeItems(state));
    } catch (error: unknown) {
      github.update([
        {
          id: "github-error",
          label: "GitHub: unavailable",
          tooltip: error instanceof Error ? error.message : String(error),
          icon: "warning",
        },
      ]);
    }
  };
  const githubAuthentication = new GitHubAuthenticationService(context, manager, refreshGitHub);
  const contextBuilder = new EditorContextBuilder(() => workspaceContext.getInfo().activeRoot);
  const controllerRef: { current?: AgentController } = {};
  const view = new AgentViewProvider(
    context.extensionUri,
    () => controllerRef.current?.state() ?? fallbackState(),
  );
  const controller = new AgentController(
    context,
    workspaceContext,
    contextBuilder,
    manager,
    settings,
    view,
    { changes, checkpoints, verification, history, orchestration },
    diffProvider,
    diagnostics,
    status,
    logger,
  );
  controllerRef.current = controller;
  view.setMessageHandler((message) => controller.handleWebview(message));

  context.subscriptions.push(
    output,
    manager,
    status,
    diffProvider,
    diagnostics,
    changes,
    checkpoints,
    verification,
    history,
    orchestration,
    github,
    githubAuthentication,
    controller,
    vscode.window.registerWebviewViewProvider("localCodeAgent.chat", view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider("agent-original", diffProvider),
    vscode.workspace.registerTextDocumentContentProvider("agent-modified", diffProvider),
    vscode.window.registerTreeDataProvider("localCodeAgent.changes", changes),
    vscode.window.registerTreeDataProvider("localCodeAgent.checkpoints", checkpoints),
    vscode.window.registerTreeDataProvider("localCodeAgent.verification", verification),
    vscode.window.registerTreeDataProvider("localCodeAgent.history", history),
    vscode.window.registerTreeDataProvider("localCodeAgent.orchestration", orchestration),
    vscode.window.registerTreeDataProvider("localCodeAgent.github", github),
    manager.onNotification((notification) => {
      if (
        notification.method.startsWith("remote.") ||
        notification.method.startsWith("pullRequest.")
      ) {
        void refreshGitHub();
      }
    }),
  );
  registerCommands(context, controller, view, () => logger.show(), githubAuthentication);

  const refreshSettings = async (): Promise<void> => {
    mapped = mapper.map(
      vscode.workspace.getConfiguration("localCodeAgent"),
      vscode.workspace.isTrusted,
    );
    settings = mapped.settings;
    controller.setSettings(settings);
    for (const warning of mapped.warnings) logger.warn(warning);
    await controller.syncRuntime();
    await refreshGitHub();
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("localCodeAgent")) void refreshSettings();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void controller.syncRuntime()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void refreshSettings()),
  );

  changes.update([{ id: "changes-empty", label: "Brak przygotowanych zmian", icon: "info" }]);
  checkpoints.update([{ id: "checkpoints-empty", label: "Brak checkpointów", icon: "info" }]);
  verification.update([
    { id: "verification-empty", label: "Brak wyników weryfikacji", icon: "info" },
  ]);
  orchestration.update([
    { id: "orchestration-empty", label: "Brak aktywnej orkiestracji", icon: "info" },
  ]);
  github.update(githubTreeItems({ enabled: settings.runtime.remoteEnabled }));
  await vscode.commands.executeCommand("setContext", "localCodeAgent.taskActive", false);
  if (settings.runtime.autoStartRuntime) {
    await controller.syncRuntime();
    void manager
      .start()
      .catch((error: unknown) =>
        logger.error(error instanceof Error ? error.message : String(error)),
      );
  }
}

export async function deactivate(): Promise<void> {
  await activeManager?.shutdown();
  activeManager = undefined;
}

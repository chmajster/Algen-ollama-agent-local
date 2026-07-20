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
    history: [],
    changes: [],
    checkpoints: [],
    verification: null,
    orchestration: null,
    github: { enabled: false, connected: false, permission: "unknown" },
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
  const controllerRef: { current?: AgentController } = {};
  const refreshGitHub = async (): Promise<void> => {
    if (!settings.runtime.remoteEnabled) {
      controllerRef.current?.setGitHubState({ enabled: false }, false);
      return;
    }
    try {
      const state = await manager.request("remote.getStatus", {}, { timeoutMs: 10_000 });
      controllerRef.current?.setGitHubState(state, true);
    } catch (error: unknown) {
      controllerRef.current?.setGitHubState(
        { enabled: true },
        true,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const githubAuthentication = new GitHubAuthenticationService(context, manager, refreshGitHub);
  const contextBuilder = new EditorContextBuilder(() => workspaceContext.getInfo().activeRoot);
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
    githubAuthentication,
    controller,
    vscode.window.registerWebviewViewProvider("localCodeAgent.chat", view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider("agent-original", diffProvider),
    vscode.workspace.registerTextDocumentContentProvider("agent-modified", diffProvider),
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

  controller.setGitHubState(
    { enabled: settings.runtime.remoteEnabled },
    settings.runtime.remoteEnabled,
  );
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

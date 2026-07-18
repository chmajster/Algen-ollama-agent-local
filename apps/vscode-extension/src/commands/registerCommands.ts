import * as vscode from "vscode";

import type { AgentMode } from "@local-code-agent/runtime-protocol";

import type { AgentController } from "../controller/agentController.js";
import type { GitHubAuthenticationService } from "../github/githubAuthenticationService.js";
import type { AgentViewProvider } from "../providers/agentViewProvider.js";

async function taskInput(title: string, prompt?: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    ignoreFocusOut: true,
    ...(prompt === undefined ? {} : { prompt }),
  });
}

export function registerCommands(
  context: vscode.ExtensionContext,
  controller: AgentController,
  view: AgentViewProvider,
  showLogs: () => void,
  github?: GitHubAuthenticationService,
): void {
  const task = (mode: AgentMode, title: string) => async (): Promise<void> => {
    const input = await taskInput(title);
    if (input !== undefined && input.trim() !== "") await controller.submit(input, mode);
  };
  const registrations: Array<[string, (...args: unknown[]) => unknown]> = [
    ["localCodeAgent.open", () => view.reveal()],
    ["localCodeAgent.ask", task("ask", "Zapytaj Local Code Agent")],
    [
      "localCodeAgent.askAboutSelection",
      async () => {
        const input = await taskInput("Zapytaj o zaznaczenie");
        if (input !== undefined) await controller.submit(input, "ask", "selection");
      },
    ],
    [
      "localCodeAgent.explainSelection",
      () =>
        controller.submit(
          "Wyjaśnij zaznaczony kod, jego działanie i istotne ryzyka.",
          "ask",
          "selection",
        ),
    ],
    [
      "localCodeAgent.fixSelection",
      () =>
        controller.submit(
          "Napraw problem w zaznaczonym kodzie i przygotuj bezpieczny podgląd zmian.",
          "edit",
          "selection",
        ),
    ],
    [
      "localCodeAgent.reviewActiveFile",
      () =>
        controller.submit(
          "Przejrzyj aktywny plik pod kątem błędów, regresji i czytelności.",
          "ask",
          "activeFile",
        ),
    ],
    ["localCodeAgent.planTask", task("plan", "Zadanie do zaplanowania")],
    ["localCodeAgent.editTask", task("edit", "Zmiana do przygotowania")],
    ["localCodeAgent.startAgentTask", task("agent", "Zadanie dla trybu Agent")],
    [
      "localCodeAgent.startOrchestratedTask",
      task("orchestrated", "Zadanie dla trybu Orchestrated"),
    ],
    ["localCodeAgent.approveOrchestration", () => controller.approveOrchestration()],
    ["localCodeAgent.rejectOrchestration", () => controller.rejectOrchestration()],
    ["localCodeAgent.cancelTask", () => controller.cancelTask()],
    [
      "localCodeAgent.previewChanges",
      (input?: unknown) =>
        controller.previewChanges(
          typeof (input as { path?: unknown } | undefined)?.path === "string"
            ? (input as { path: string }).path
            : undefined,
        ),
    ],
    ["localCodeAgent.applyChanges", () => controller.applyChanges()],
    ["localCodeAgent.rejectChanges", () => controller.rejectChanges()],
    ["localCodeAgent.runVerification", () => controller.runVerification()],
    ["localCodeAgent.showVerification", () => controller.showVerification()],
    [
      "localCodeAgent.showDiff",
      (input?: unknown) =>
        controller.showDiff(
          typeof (input as { path?: unknown } | undefined)?.path === "string"
            ? (input as { path: string }).path
            : undefined,
        ),
    ],
    ["localCodeAgent.restoreCheckpoint", (input?: unknown) => controller.restoreCheckpoint(input)],
    ["localCodeAgent.restartRuntime", () => controller.restartRuntime()],
    [
      "localCodeAgent.openSettings",
      () =>
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "@ext:local-code-agent.local-code-agent-vscode",
        ),
    ],
    ["localCodeAgent.showLogs", showLogs],
    ["localCodeAgent.runDoctor", () => controller.runDoctor()],
    ["localCodeAgent.github.connect", () => github?.connect()],
    ["localCodeAgent.github.disconnect", () => github?.disconnect()],
    ["localCodeAgent.github.showAccount", () => github?.showAccount()],
    ["localCodeAgent.github.verifyRepository", () => github?.verifyRepository()],
    ["localCodeAgent.github.refresh", () => github?.showAccount()],
    ["localCodeAgent.github.publishTask", () => github?.publishTask()],
    ["localCodeAgent.github.createDraftPullRequest", () => github?.createDraftPullRequest()],
    ["localCodeAgent.github.refreshChecks", () => github?.refreshChecks()],
    ["localCodeAgent.github.openPullRequest", () => github?.openPullRequest()],
    ["localCodeAgent.github.replyToReview", () => github?.replyToReview()],
    ["localCodeAgent.github.resolveReviewThread", () => github?.resolveReviewThread()],
  ];
  context.subscriptions.push(
    ...registrations.map(([name, handler]) => vscode.commands.registerCommand(name, handler)),
  );
}

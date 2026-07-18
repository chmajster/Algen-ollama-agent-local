import { resolve } from "node:path";

import * as vscode from "vscode";

import type { WorkspaceInfo } from "@local-code-agent/runtime-protocol";

const ACTIVE_ROOT_KEY = "localCodeAgent.activeWorkspaceRoot";

export class WorkspaceContext {
  public constructor(private readonly state: vscode.Memento) {}

  public getInfo(): WorkspaceInfo {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = folders.map((folder) => resolve(folder.uri.fsPath));
    const stored = this.state.get<string>(ACTIVE_ROOT_KEY);
    let activeRoot =
      stored !== undefined && roots.includes(resolve(stored)) ? resolve(stored) : null;
    if (activeRoot === null && roots.length === 1) activeRoot = roots[0] ?? null;
    return {
      activeRoot,
      roots,
      trusted: vscode.workspace.isTrusted,
      kind: roots.length === 0 ? "none" : roots.length === 1 ? "single-root" : "multi-root",
    };
  }

  public async selectActiveRoot(): Promise<WorkspaceInfo> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showInformationMessage(
        "Otwórz folder lub workspace, aby wybrać katalog agenta.",
      );
      return this.getInfo();
    }
    if (folders.length === 1) {
      await this.state.update(ACTIVE_ROOT_KEY, resolve(folders[0]?.uri.fsPath ?? ""));
      return this.getInfo();
    }
    const selected = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      {
        title: "Aktywny folder Local Code Agent",
        placeHolder: "Wybierz jeden root dla bieżącej sesji",
      },
    );
    if (selected !== undefined)
      await this.state.update(ACTIVE_ROOT_KEY, resolve(selected.folder.uri.fsPath));
    return this.getInfo();
  }
}

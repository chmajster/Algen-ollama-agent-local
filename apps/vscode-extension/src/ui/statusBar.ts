import * as vscode from "vscode";

import type { RuntimeState, TaskPhase } from "@local-code-agent/runtime-protocol";

export class AgentStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private lastText = "";

  public constructor() {
    this.item.command = "localCodeAgent.open";
    this.item.tooltip = "Otwórz Local Code Agent";
    this.updateRuntime("stopped");
    this.item.show();
  }

  private set(text: string, icon: string): void {
    const next = `$(${icon}) Agent: ${text}`;
    if (this.lastText === next) return;
    this.lastText = next;
    this.item.text = next;
  }

  public updateRuntime(state: RuntimeState): void {
    if (state === "ready") this.set("Ready", "check");
    else if (state === "failed") this.set("Failed", "error");
    else if (state === "starting" || state === "restarting") this.set("Starting", "sync~spin");
    else if (state === "busy") this.set("Analyzing", "loading~spin");
    else this.set("Stopped", "circle-outline");
  }

  public updatePhase(phase: TaskPhase): void {
    if (["analysis", "planning", "baseline"].includes(phase)) this.set("Analyzing", "loading~spin");
    else if (["editing", "preview"].includes(phase)) this.set("Editing", "edit");
    else if (phase === "confirmation") this.set("Awaiting approval", "question");
    else if (["verification", "repair"].includes(phase)) this.set("Verifying", "beaker");
    else if (phase === "failed") this.set("Failed", "error");
    else if (phase === "completed" || phase === "cancelled") this.set("Ready", "check");
  }

  public dispose(): void {
    this.item.dispose();
  }
}

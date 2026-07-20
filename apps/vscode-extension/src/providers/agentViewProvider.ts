import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import {
  hostToWebviewSchema,
  webviewToHostSchema,
  type AgentViewState,
  type HostToWebviewMessage,
  type WebviewToHostMessage,
} from "../webview/messages.js";

export class AgentViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private handler: ((message: WebviewToHostMessage) => Promise<void>) | undefined;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: () => AgentViewState,
  ) {}

  public setMessageHandler(handler: (message: WebviewToHostMessage) => Promise<void>): void {
    this.handler = handler;
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const parsed = webviewToHostSchema.safeParse(raw);
      if (!parsed.success) {
        void this.post({ type: "error.show", message: "Webview wysłał nieprawidłową wiadomość.", code: "WEBVIEW_MESSAGE_INVALID" });
        return;
      }
      void this.handler?.(parsed.data).catch((error: unknown) => {
        void this.post({ type: "error.show", message: error instanceof Error ? error.message : String(error) });
      });
    });
  }

  public async reveal(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.localCodeAgent");
    this.view?.show?.(true);
  }

  public async post(message: HostToWebviewMessage): Promise<boolean> {
    return this.view?.webview.postMessage(hostToWebviewSchema.parse(message)) ?? false;
  }

  public async update(): Promise<void> {
    await this.post({ type: "state.updated", state: this.state() });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(24).toString("base64url");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.css"));
    return `<!doctype html>
<html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"><title>Local Code Agent</title></head>
<body><div class="shell">
<header class="panel-header"><div class="workspace-line"><strong id="workspace">Local Code Agent</strong><span id="trust" class="muted"></span></div><div class="header-actions"><span id="runtime" class="status-badge" aria-live="polite">stopped</span><button id="restart" class="icon-button" type="button" title="Restartuj runtime" aria-label="Restartuj runtime">↻</button><button id="logs" class="icon-button" type="button" title="Pokaż logi" aria-label="Pokaż logi">≡</button><button id="settings" class="icon-button" type="button" title="Otwórz ustawienia" aria-label="Otwórz ustawienia">⚙</button></div></header>
<nav id="tabs" class="tabs" role="tablist" aria-label="Sekcje panelu"><button role="tab" data-tab="chat">Czat</button><button role="tab" data-tab="tasks">Zadania <span id="tasks-count" class="count"></span></button><button role="tab" data-tab="changes">Zmiany <span id="changes-count" class="count"></span></button><button role="tab" data-tab="verification">Weryfikacja</button><button role="tab" data-tab="orchestration">Orkiestracja</button><button role="tab" data-tab="github">GitHub</button></nav>
<div id="status-live" class="sr-only" aria-live="polite"></div>
<section id="tab-chat" class="tab-panel chat-panel" role="tabpanel"><div class="section-header"><div><strong id="task-title">Nowe zadanie</strong><span id="task-phase" class="muted"></span></div></div><main id="messages" class="messages" aria-live="polite"></main>
<form id="composer" class="composer"><label class="sr-only" for="task">Polecenie dla agenta</label><textarea id="task" rows="1" placeholder="Opisz zadanie…" required></textarea><div class="composer-row"><label class="compact-control"><span class="sr-only">Kontekst</span><select id="context" aria-label="Kontekst"><option value="none">Bez kontekstu</option><option value="activeFile">Aktywny plik</option><option value="selection">Zaznaczenie</option><option value="openFiles">Otwarte pliki</option><option value="diagnostics">Diagnostyka</option><option value="gitDiff">Git diff</option></select></label><label class="compact-control mode-control"><span class="sr-only">Tryb</span><select id="mode" aria-label="Tryb"><option value="ask">Ask</option><option value="plan">Plan</option><option value="edit">Edit</option><option value="agent">Agent</option><option value="orchestrated">Orchestrated</option></select></label><span class="spacer"></span><button id="cancel" type="button" class="icon-button cancel-button" title="Anuluj zadanie" aria-label="Anuluj zadanie" hidden>■</button><button id="send" type="submit" class="send-button" title="Wyślij (Enter)" aria-label="Wyślij polecenie">↑</button></div></form></section>
<section id="tab-tasks" class="tab-panel" role="tabpanel" hidden><div class="section-header"><h1>Zadania</h1><button id="new-task" type="button">＋ Nowe</button></div><label class="filter"><span class="sr-only">Filtruj zadania</span><input id="task-filter" type="search" placeholder="Filtruj zadania…"></label><div id="task-list" class="item-list"></div></section>
<section id="tab-changes" class="tab-panel" role="tabpanel" hidden><div class="section-header"><h1>Zmiany</h1><span id="change-status" class="muted"></span></div><div id="change-list" class="item-list"></div><div class="button-row"><button id="preview" type="button" class="secondary">Pokaż diff</button><button id="apply" type="button">Zastosuj</button><button id="reject" type="button" class="danger">Odrzuć</button></div><details class="subsection"><summary>Checkpointy <span id="checkpoint-count" class="count"></span></summary><div id="checkpoint-list" class="item-list"></div></details></section>
<section id="tab-verification" class="tab-panel" role="tabpanel" hidden><div class="section-header"><h1>Weryfikacja</h1><button id="verify" type="button">Uruchom</button></div><div id="verification-summary"></div><div id="verification-list" class="item-list"></div></section>
<section id="tab-orchestration" class="tab-panel" role="tabpanel" hidden><div class="section-header"><h1>Orkiestracja</h1></div><div id="orchestration-content"></div><div id="orchestration-actions" class="button-row" hidden><button id="orchestration-approve" type="button">Zatwierdź</button><button id="orchestration-reject" type="button" class="danger">Odrzuć</button></div></section>
<section id="tab-github" class="tab-panel" role="tabpanel" hidden><div class="section-header"><h1>GitHub</h1></div><div id="github-content"></div><div class="button-row wrap"><button id="github-connect" type="button">Połącz</button><button id="github-refresh" type="button" class="secondary">Odśwież</button><button id="github-publish" type="button" class="secondary">Publikuj branch</button><button id="github-pr" type="button" class="secondary">Utwórz Draft PR</button></div></section>
</div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}

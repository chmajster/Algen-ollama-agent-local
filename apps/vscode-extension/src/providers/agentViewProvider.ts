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
        void this.post({
          type: "error.show",
          message: "Webview wysłał nieprawidłową wiadomość.",
          code: "WEBVIEW_MESSAGE_INVALID",
        });
        return;
      }
      void this.handler?.(parsed.data).catch((error: unknown) => {
        void this.post({
          type: "error.show",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  public async reveal(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.localCodeAgent");
    this.view?.show?.(true);
  }

  public async post(message: HostToWebviewMessage): Promise<boolean> {
    const parsed = hostToWebviewSchema.parse(message);
    return this.view?.webview.postMessage(parsed) ?? false;
  }

  public async update(): Promise<void> {
    await this.post({ type: "state.updated", state: this.state() });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(24).toString("base64url");
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.js"),
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.css"),
    );
    return `<!doctype html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>Local Code Agent</title>
</head>
<body>
  <header><div><strong>Local Code Agent</strong><span id="workspace"></span></div><span id="runtime" class="badge">Stopped</span></header>
  <section class="controls" aria-label="Tryb i kontekst">
    <label>Tryb<select id="mode"><option value="ask">Ask</option><option value="plan">Plan</option><option value="edit">Edit</option><option value="agent">Agent</option><option value="orchestrated">Orchestrated</option></select></label>
    <label>Kontekst<select id="context"><option value="none">None</option><option value="activeFile">Active file</option><option value="selection">Selection</option><option value="openFiles">Open files</option><option value="diagnostics">Diagnostics</option><option value="gitDiff">Git diff</option></select></label>
  </section>
  <main id="messages" aria-live="polite"></main>
  <section id="summary" class="summary" hidden></section>
  <form id="composer">
    <label class="sr-only" for="task">Zadanie dla agenta</label>
    <textarea id="task" rows="4" placeholder="Opisz zadanie…" required></textarea>
    <div class="actions"><button id="cancel" type="button" class="secondary" hidden>Anuluj</button><button type="submit">Wyślij</button></div>
  </form>
  <nav class="footer"><button id="preview" class="link" type="button">Diff</button><button id="apply" class="link" type="button">Zastosuj</button><button id="reject" class="link" type="button">Odrzuć</button><button id="verify" class="link" type="button">Weryfikuj</button><button id="settings" class="link" type="button">Ustawienia</button></nav>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

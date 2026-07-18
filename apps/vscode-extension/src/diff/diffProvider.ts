import * as vscode from "vscode";

export interface DiffPair {
  original: string;
  modified: string;
}

export function splitUnifiedDiff(diff: string): DiffPair {
  const original: string[] = [];
  const modified: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-")) original.push(line.slice(1));
    else if (line.startsWith("+")) modified.push(line.slice(1));
    else if (line.startsWith(" ")) {
      original.push(line.slice(1));
      modified.push(line.slice(1));
    }
  }
  return { original: original.join("\n"), modified: modified.join("\n") };
}

export class AgentDiffProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly documents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.changed.event;

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? "";
  }

  public register(path: string, diff: string): { original: vscode.Uri; modified: vscode.Uri } {
    const pair = splitUnifiedDiff(diff);
    const query = `path=${encodeURIComponent(path)}&id=${Date.now().toString(36)}`;
    const original = vscode.Uri.from({ scheme: "agent-original", path: `/${path}`, query });
    const modified = vscode.Uri.from({ scheme: "agent-modified", path: `/${path}`, query });
    this.documents.set(original.toString(), pair.original);
    this.documents.set(modified.toString(), pair.modified);
    this.changed.fire(original);
    this.changed.fire(modified);
    return { original, modified };
  }

  public dispose(): void {
    this.documents.clear();
    this.changed.dispose();
  }
}

import { resolve } from "node:path";

import * as vscode from "vscode";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function diagnosticSeverity(value: unknown): vscode.DiagnosticSeverity {
  if (value === "warning") return vscode.DiagnosticSeverity.Warning;
  if (value === "information") return vscode.DiagnosticSeverity.Information;
  if (value === "hint") return vscode.DiagnosticSeverity.Hint;
  return vscode.DiagnosticSeverity.Error;
}

export class AgentDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("local-code-agent");

  public update(report: unknown, activeRoot: string | null): void {
    this.collection.clear();
    if (activeRoot === null) return;
    const diagnostics = record(report)?.diagnostics;
    if (!Array.isArray(diagnostics)) return;
    const byUri = new Map<string, { uri: vscode.Uri; values: vscode.Diagnostic[] }>();
    for (const raw of diagnostics.slice(0, 500)) {
      const item = record(raw);
      if (item === undefined || typeof item.path !== "string" || item.path === "") continue;
      const uri = vscode.Uri.file(resolve(activeRoot, item.path));
      const line = Math.max(0, Number(item.line ?? 1) - 1);
      const column = Math.max(0, Number(item.column ?? 1) - 1);
      const endLine = Math.max(line, Number(item.endLine ?? line + 1) - 1);
      const endColumn = Math.max(column + 1, Number(item.endColumn ?? column + 2) - 1);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(line, column, endLine, endColumn),
        String(item.message ?? "Błąd weryfikacji"),
        diagnosticSeverity(item.severity),
      );
      diagnostic.source = typeof item.source === "string" ? item.source : "Local Code Agent";
      if (typeof item.code === "string" || typeof item.code === "number")
        diagnostic.code = item.code;
      const entry = byUri.get(uri.toString()) ?? { uri, values: [] };
      entry.values.push(diagnostic);
      byUri.set(uri.toString(), entry);
    }
    this.collection.set([...byUri.values()].map((entry) => [entry.uri, entry.values]));
  }

  public clear(): void {
    this.collection.clear();
  }

  public dispose(): void {
    this.collection.dispose();
  }
}

import { relative, resolve } from "node:path";

import * as vscode from "vscode";

import type { EditorContext } from "@local-code-agent/runtime-protocol";

export type EditorContextKind =
  "none" | "activeFile" | "selection" | "openFiles" | "diagnostics" | "gitDiff";

const MAX_CONTEXT_CHARS = 50_000;
const MAX_DIAGNOSTICS = 100;

export class EditorDocumentDirtyError extends Error {
  public readonly code = "EDITOR_DOCUMENT_DIRTY";

  public constructor(public readonly paths: string[]) {
    super(`Niezapisane dokumenty blokują operację: ${paths.join(", ")}.`);
    this.name = "EditorDocumentDirtyError";
  }
}

interface GitRepository {
  rootUri: vscode.Uri;
  diff(cached?: boolean): Promise<string>;
}
interface GitApi {
  repositories: GitRepository[];
}
interface GitExtension {
  getAPI(version: 1): GitApi;
}

function relativePath(root: string, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== "file") return undefined;
  const result = relative(resolve(root), resolve(uri.fsPath)).replaceAll("\\", "/");
  if (result === "" || result.startsWith("../") || result === "..") return undefined;
  return result;
}

function severity(value: vscode.DiagnosticSeverity): "error" | "warning" | "information" | "hint" {
  if (value === vscode.DiagnosticSeverity.Error) return "error";
  if (value === vscode.DiagnosticSeverity.Warning) return "warning";
  if (value === vscode.DiagnosticSeverity.Hint) return "hint";
  return "information";
}

export class EditorContextBuilder {
  public constructor(
    private readonly activeRoot: () => string | null,
    private readonly onLimit: (message: string) => void = (message) =>
      void vscode.window.showWarningMessage(message),
  ) {}

  private base(editor: vscode.TextEditor, root: string): EditorContext | undefined {
    const path = relativePath(root, editor.document.uri);
    if (path === undefined) return undefined;
    return {
      activeFile: path,
      languageId: editor.document.languageId,
      documentVersion: editor.document.version,
      documentDirty: editor.document.isDirty,
      openFiles: [],
      diagnostics: [],
    };
  }

  private limited(content: string, label: string): string {
    if (content.length <= MAX_CONTEXT_CHARS) return content;
    this.onLimit(
      `${label} przekracza ${MAX_CONTEXT_CHARS.toLocaleString("pl-PL")} znaków i zostało skrócone.`,
    );
    return content.slice(0, MAX_CONTEXT_CHARS);
  }

  private diagnostics(root: string, uri?: vscode.Uri): EditorContext["diagnostics"] {
    const entries =
      uri === undefined
        ? vscode.languages.getDiagnostics()
        : [[uri, vscode.languages.getDiagnostics(uri)] as const];
    return entries
      .flatMap(([diagnosticUri, values]) => {
        const path = relativePath(root, diagnosticUri);
        if (path === undefined) return [];
        return values.map((item) => ({
          path,
          line: item.range.start.line,
          column: item.range.start.character,
          endLine: item.range.end.line,
          endColumn: item.range.end.character,
          severity: severity(item.severity),
          message: item.message.slice(0, 2_000),
          ...(item.source === undefined ? {} : { source: item.source }),
          ...(item.code === undefined
            ? {}
            : { code: typeof item.code === "object" ? item.code.value : item.code }),
        }));
      })
      .slice(0, MAX_DIAGNOSTICS);
  }

  private async gitDiff(root: string): Promise<string | undefined> {
    const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (extension === undefined) return undefined;
    const api = extension.isActive
      ? extension.exports.getAPI(1)
      : (await extension.activate()).getAPI(1);
    const repository = api.repositories.find(
      (item) => resolve(item.rootUri.fsPath) === resolve(root),
    );
    if (repository === undefined) return undefined;
    return this.limited(await repository.diff(), "Git diff");
  }

  public async build(kind: EditorContextKind): Promise<EditorContext | undefined> {
    if (kind === "none") return undefined;
    const root = this.activeRoot();
    if (root === null) return undefined;
    const editor = vscode.window.activeTextEditor;
    const base =
      editor === undefined
        ? { openFiles: [], diagnostics: [] }
        : (this.base(editor, root) ?? { openFiles: [], diagnostics: [] });
    if (kind === "selection") {
      if (editor === undefined || editor.selection.isEmpty || base.activeFile === undefined)
        return base;
      return {
        ...base,
        selection: this.limited(editor.document.getText(editor.selection), "Zaznaczenie"),
        selectionStartLine: editor.selection.start.line + 1,
        selectionEndLine: editor.selection.end.line + 1,
      };
    }
    if (kind === "activeFile" && editor !== undefined && base.activeFile !== undefined) {
      const visible = vscode.window.visibleTextEditors.find(
        (item) => item.document === editor.document,
      )?.visibleRanges[0];
      const content = editor.document.getText(visible);
      return { ...base, activeFileContent: this.limited(content, "Kontekst aktywnego pliku") };
    }
    if (kind === "openFiles") {
      return {
        ...base,
        openFiles: vscode.workspace.textDocuments
          .map((document) => relativePath(root, document.uri))
          .filter((path): path is string => path !== undefined)
          .slice(0, 100),
      };
    }
    if (kind === "diagnostics")
      return { ...base, diagnostics: this.diagnostics(root, editor?.document.uri) };
    if (kind === "gitDiff") {
      const gitDiff = await this.gitDiff(root);
      return { ...base, ...(gitDiff === undefined ? {} : { gitDiff }) };
    }
    return base;
  }

  public assertNoDirtyDocuments(paths: readonly string[]): void {
    const root = this.activeRoot();
    if (root === null) return;
    const normalized = new Set(paths.map((path) => path.replaceAll("\\", "/").toLowerCase()));
    const dirty = vscode.workspace.textDocuments
      .filter((document) => document.isDirty)
      .map((document) => relativePath(root, document.uri))
      .filter(
        (path): path is string =>
          path !== undefined && (normalized.size === 0 || normalized.has(path.toLowerCase())),
      );
    if (dirty.length > 0) throw new EditorDocumentDirtyError(dirty);
  }
}

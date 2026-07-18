import { formatPatch, structuredPatch } from "diff";

export interface FileDiffResult {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
  truncated: boolean;
}

function logical(path: string): string {
  return path.replaceAll("\\", "/");
}

function countChanges(lines: string[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export class DiffService {
  public constructor(private readonly maxDiffChars: number) {}

  private build(
    path: string,
    oldName: string,
    newName: string,
    oldContent: string,
    newContent: string,
  ): FileDiffResult {
    const patch = structuredPatch(oldName, newName, oldContent, newContent, undefined, undefined, {
      context: 3,
    });
    const counts = countChanges(patch.hunks.flatMap((hunk) => hunk.lines));
    const fullDiff = formatPatch(patch);
    if (fullDiff.length <= this.maxDiffChars) {
      return { path: logical(path), diff: fullDiff, ...counts, truncated: false };
    }
    return {
      path: logical(path),
      diff: [
        `Diff dla ${logical(path)} przekracza limit ${this.maxDiffChars} znaków.`,
        `Dodane linie: ${counts.additions}`,
        `Usunięte linie: ${counts.deletions}`,
        "Użyj get_file_diff dla bardziej precyzyjnej operacji lub zmniejsz zakres zmian.",
      ].join("\n"),
      ...counts,
      truncated: true,
    };
  }

  public modified(path: string, oldContent: string, newContent: string): FileDiffResult {
    const normalized = logical(path);
    return this.build(normalized, `a/${normalized}`, `b/${normalized}`, oldContent, newContent);
  }

  public created(path: string, content: string): FileDiffResult {
    const normalized = logical(path);
    return this.build(normalized, "/dev/null", `b/${normalized}`, "", content);
  }

  public deleted(path: string, content: string): FileDiffResult {
    const normalized = logical(path);
    return this.build(normalized, `a/${normalized}`, "/dev/null", content, "");
  }

  public moved(sourcePath: string, destinationPath: string): FileDiffResult {
    const source = logical(sourcePath);
    const destination = logical(destinationPath);
    const diff = [
      "similarity index 100%",
      `rename from ${source}`,
      `rename to ${destination}`,
      "",
    ].join("\n");
    return {
      path: destination,
      diff,
      additions: 0,
      deletions: 0,
      truncated: false,
    };
  }

  public combine(fileDiffs: readonly FileDiffResult[]): {
    diff: string;
    truncated: boolean;
  } {
    const full = fileDiffs.map((item) => item.diff.trimEnd()).join("\n");
    const anyTruncated = fileDiffs.some((item) => item.truncated);
    if (full.length <= this.maxDiffChars) {
      return { diff: full, truncated: anyTruncated };
    }
    return {
      diff: [
        `Łączny diff przekracza limit ${this.maxDiffChars} znaków.`,
        `Liczba plików: ${fileDiffs.length}`,
        `Dodane linie: ${fileDiffs.reduce((total, item) => total + item.additions, 0)}`,
        `Usunięte linie: ${fileDiffs.reduce((total, item) => total + item.deletions, 0)}`,
        "Pobierz diff konkretnego pliku narzędziem get_file_diff.",
      ].join("\n"),
      truncated: true,
    };
  }
}

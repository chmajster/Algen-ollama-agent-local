import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  PathOutsideWorkspaceError,
  SymlinkEscapeError,
  WorkspaceAccessError,
  WorkspaceNotFoundError,
} from "./errors.js";

export interface ResolvedWorkspacePath {
  absolutePath: string;
  realPath: string;
  relativePath: string;
  isSymbolicLink: boolean;
}

function isOutside(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference);
}

function normalizeInput(input: string): string {
  const alternateSeparator = sep === "/" ? "\\" : "/";
  return input.replaceAll(alternateSeparator, sep);
}

function hasTraversal(input: string): boolean {
  return normalizeInput(input)
    .split(sep)
    .some((part) => part === "..");
}

function logicalPath(root: string, target: string): string {
  const value = relative(root, target);
  return value === "" ? "." : value.split(sep).join("/");
}

export class PathSecurity {
  private constructor(public readonly root: string) {}

  public static async create(workspaceRoot: string): Promise<PathSecurity> {
    const absoluteRoot = resolve(workspaceRoot);
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(absoluteRoot);
    } catch (error: unknown) {
      throw new WorkspaceNotFoundError(absoluteRoot, { cause: error });
    }

    try {
      const rootStats = await stat(canonicalRoot);
      if (!rootStats.isDirectory()) {
        throw new WorkspaceAccessError("Skonfigurowany workspace nie jest katalogiem.");
      }
      await access(canonicalRoot, constants.R_OK);
    } catch (error: unknown) {
      if (error instanceof WorkspaceAccessError) {
        throw error;
      }
      throw new WorkspaceAccessError("Skonfigurowany workspace nie jest możliwy do odczytu.", {
        cause: error,
      });
    }

    return new PathSecurity(canonicalRoot);
  }

  public async resolveExisting(input = "."): Promise<ResolvedWorkspacePath> {
    if (input.includes("\0") || hasTraversal(input)) {
      throw new PathOutsideWorkspaceError();
    }

    const normalized = normalizeInput(input.trim() === "" ? "." : input);
    const lexicalTarget = isAbsolute(normalized)
      ? resolve(normalized)
      : resolve(this.root, normalized);
    if (isOutside(this.root, lexicalTarget)) {
      throw new PathOutsideWorkspaceError();
    }

    let linkStats: Awaited<ReturnType<typeof lstat>>;
    let canonicalTarget: string;
    try {
      [linkStats, canonicalTarget] = await Promise.all([
        lstat(lexicalTarget),
        realpath(lexicalTarget),
      ]);
    } catch (error: unknown) {
      throw new WorkspaceAccessError(
        "Wskazana ścieżka nie istnieje lub nie jest możliwa do odczytu.",
        {
          cause: error,
        },
      );
    }

    if (isOutside(this.root, canonicalTarget)) {
      if (linkStats.isSymbolicLink()) {
        throw new SymlinkEscapeError();
      }
      throw new PathOutsideWorkspaceError();
    }

    return {
      absolutePath: lexicalTarget,
      realPath: canonicalTarget,
      relativePath: logicalPath(this.root, lexicalTarget),
      isSymbolicLink: linkStats.isSymbolicLink(),
    };
  }

  public async resolveFile(input: string): Promise<ResolvedWorkspacePath> {
    const resolvedPath = await this.resolveExisting(input);
    const fileStats = await stat(resolvedPath.realPath);
    if (!fileStats.isFile()) {
      throw new WorkspaceAccessError("Wskazana ścieżka nie jest plikiem.");
    }
    return resolvedPath;
  }

  public async resolveDirectory(input = "."): Promise<ResolvedWorkspacePath> {
    const resolvedPath = await this.resolveExisting(input);
    const directoryStats = await stat(resolvedPath.realPath);
    if (!directoryStats.isDirectory()) {
      throw new WorkspaceAccessError("Wskazana ścieżka nie jest katalogiem.");
    }
    return resolvedPath;
  }
}

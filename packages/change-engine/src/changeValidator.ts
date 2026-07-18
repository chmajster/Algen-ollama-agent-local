import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { isBinaryFile, isSensitiveFile } from "@local-code-agent/workspace";

import {
  BinaryFileWriteError,
  FileAlreadyExistsError,
  FileNotFoundForWriteError,
  InvalidFileNameError,
  ProtectedPathWriteError,
  SensitiveFileWriteError,
  SymlinkWriteBlockedError,
} from "./errors.js";

const BLOCKED_DIRECTORIES = new Set([
  ".git",
  ".agent",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "target",
  "bin",
  "obj",
]);

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export interface ChangeValidatorOptions {
  workspaceRoot: string;
  allowSensitiveFileWrite: boolean;
  allowSymlinkWrite: boolean;
  platform?: NodeJS.Platform;
}

export interface ValidatedWritePath {
  absolutePath: string;
  relativePath: string;
}

function outside(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference);
}

function normalizeSeparators(input: string): string {
  return input.replaceAll(sep === "/" ? "\\" : "/", sep);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export class ChangeValidator {
  public readonly workspaceRoot: string;
  private readonly platform: NodeJS.Platform;

  private constructor(
    private readonly options: ChangeValidatorOptions,
    workspaceRoot: string,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.platform = options.platform ?? process.platform;
  }

  public static async create(options: ChangeValidatorOptions): Promise<ChangeValidator> {
    const root = await realpath(resolve(options.workspaceRoot));
    return new ChangeValidator(options, root);
  }

  private validateInput(input: string): ValidatedWritePath {
    if (input.trim() === "" || input.includes("\0")) {
      throw new InvalidFileNameError();
    }
    const normalized = normalizeSeparators(input);
    const rawParts = normalized.split(sep);
    if (
      !isAbsolute(normalized) &&
      rawParts.some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new InvalidFileNameError("Ścieżka zawiera pusty segment, . albo ...");
    }
    const absolutePath = isAbsolute(normalized)
      ? resolve(normalized)
      : resolve(this.workspaceRoot, normalized);
    if (outside(this.workspaceRoot, absolutePath)) {
      throw new ProtectedPathWriteError("Zapis poza skonfigurowanym workspace jest zablokowany.");
    }
    const logicalPath = relative(this.workspaceRoot, absolutePath).split(sep).join("/");
    const parts = logicalPath.split("/");
    if (parts.some((part) => BLOCKED_DIRECTORIES.has(part.toLowerCase()))) {
      throw new ProtectedPathWriteError(undefined, logicalPath);
    }
    if (!this.options.allowSensitiveFileWrite && isSensitiveFile(logicalPath)) {
      throw new SensitiveFileWriteError(undefined, logicalPath);
    }
    const maxLength = this.platform === "win32" ? 240 : 4_096;
    if (absolutePath.length > maxLength) {
      throw new InvalidFileNameError("Ścieżka pliku jest zbyt długa.", logicalPath);
    }
    if (this.platform === "win32") {
      for (const part of parts) {
        if (/[<>:"|?*]/u.test(part) || /[. ]$/u.test(part) || WINDOWS_RESERVED.test(part)) {
          throw new InvalidFileNameError(undefined, logicalPath);
        }
      }
    }
    return { absolutePath, relativePath: logicalPath };
  }

  public async target(input: string): Promise<ValidatedWritePath> {
    const path = this.validateInput(input);
    await this.validateSymlinkChain(path);
    return path;
  }

  private async validateSymlinkChain(path: ValidatedWritePath): Promise<void> {
    const parts = path.relativePath.split("/");
    let current = this.workspaceRoot;
    for (const part of parts) {
      current = resolve(current, part);
      try {
        const metadata = await lstat(current);
        if (!metadata.isSymbolicLink()) continue;
        if (!this.options.allowSymlinkWrite) {
          throw new SymlinkWriteBlockedError(undefined, path.relativePath);
        }
        const canonical = await realpath(current);
        if (outside(this.workspaceRoot, canonical)) {
          throw new SymlinkWriteBlockedError(undefined, path.relativePath);
        }
      } catch (error: unknown) {
        if (isMissing(error)) return;
        throw error;
      }
    }
  }

  public async existingFile(input: string): Promise<ValidatedWritePath> {
    const path = this.validateInput(input);
    await this.validateSymlinkChain(path);
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(path.absolutePath);
    } catch (error: unknown) {
      if (isMissing(error)) {
        throw new FileNotFoundForWriteError(undefined, path.relativePath, { cause: error });
      }
      throw error;
    }
    if (!metadata.isFile()) {
      throw new FileNotFoundForWriteError("Wskazana ścieżka nie jest plikiem.", path.relativePath);
    }
    const canonical = await realpath(path.absolutePath);
    if (outside(this.workspaceRoot, canonical)) {
      throw new SymlinkWriteBlockedError(undefined, path.relativePath);
    }
    return path;
  }

  public async newFile(input: string): Promise<ValidatedWritePath> {
    const path = this.validateInput(input);
    await this.validateSymlinkChain(path);
    try {
      await lstat(path.absolutePath);
      throw new FileAlreadyExistsError(undefined, path.relativePath);
    } catch (error: unknown) {
      if (isMissing(error)) return path;
      throw error;
    }
  }

  public async assertTextFile(path: ValidatedWritePath): Promise<void> {
    if (await isBinaryFile(path.absolutePath)) {
      throw new BinaryFileWriteError(undefined, path.relativePath);
    }
  }
}

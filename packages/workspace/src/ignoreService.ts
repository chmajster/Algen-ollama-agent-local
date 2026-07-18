import { readFile } from "node:fs/promises";
import { join } from "node:path";

import ignore from "ignore";
import type { Ignore } from "ignore";

const ALWAYS_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".tmp",
  "temp",
  "target",
  "bin",
  "obj",
  "venv",
  ".venv",
  "__pycache__",
  ".idea",
  ".vscode",
]);

interface IgnoreRules {
  base: string;
  matcher: Ignore;
}

function isWithinBase(path: string, base: string): boolean {
  return base === "." || path === base || path.startsWith(`${base}/`);
}

function relativeToBase(path: string, base: string): string {
  return base === "." ? path : path.slice(base.length + 1);
}

export interface IgnoreServiceOptions {
  root: string;
  respectGitignore: boolean;
  includeHiddenFiles: boolean;
}

export class IgnoreService {
  private readonly rules = new Map<string, IgnoreRules>();

  public constructor(private readonly options: IgnoreServiceOptions) {}

  public async loadRulesForDirectory(
    absoluteDirectory: string,
    relativeDirectory: string,
  ): Promise<void> {
    if (!this.options.respectGitignore || this.rules.has(relativeDirectory)) {
      return;
    }

    let contents: string;
    try {
      contents = await readFile(join(absoluteDirectory, ".gitignore"), "utf8");
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "ENOENT") {
        this.rules.set(relativeDirectory, {
          base: relativeDirectory,
          matcher: ignore({ ignorecase: process.platform === "win32" }),
        });
        return;
      }
      throw error;
    }

    this.rules.set(relativeDirectory, {
      base: relativeDirectory,
      matcher: ignore({ ignorecase: process.platform === "win32" }).add(contents),
    });
  }

  public isIgnored(relativePath: string, isDirectory: boolean): boolean {
    const logicalPath = relativePath.replaceAll("\\", "/");
    const parts = logicalPath.split("/");
    const name = parts.at(-1) ?? "";

    if (isDirectory && ALWAYS_IGNORED_DIRECTORIES.has(name.toLowerCase())) {
      return true;
    }
    if (!this.options.includeHiddenFiles && name.startsWith(".") && name !== ".") {
      return true;
    }
    if (!this.options.respectGitignore) {
      return false;
    }

    const candidate = isDirectory ? `${logicalPath}/` : logicalPath;
    let ignored = false;
    for (const { base, matcher } of this.rules.values()) {
      if (!isWithinBase(logicalPath, base)) {
        continue;
      }
      const nestedCandidate = relativeToBase(candidate, base);
      if (nestedCandidate !== "") {
        const test = matcher.test(nestedCandidate);
        if (test.ignored) ignored = true;
        if (test.unignored) ignored = false;
      }
    }
    return ignored;
  }

  public isAlwaysBlockedPath(relativePath: string): boolean {
    return relativePath
      .replaceAll("\\", "/")
      .split("/")
      .some((part) => part.toLowerCase() === ".git");
  }
}

import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ExecutableInfo } from "./commandTypes.js";

const KNOWN_EXECUTABLES = new Set([
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "python",
  "python3",
  "pip",
  "pip3",
  "pytest",
  "ruff",
  "mypy",
  "pyright",
  "poetry",
  "uv",
  "go",
  "gofmt",
  "cargo",
  "rustc",
  "mvn",
  "mvnw",
  "gradle",
  "gradlew",
  "dotnet",
  "php",
  "composer",
  "java",
  "javac",
  "git",
  "docker",
  "eslint",
  "tsc",
  "prettier",
  "vitest",
  "jest",
  "phpunit",
  "phpstan",
  "phpcs",
  "pwsh",
  "powershell",
  "cmd",
  "bash",
  "zsh",
  "sh",
]);

function outside(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference);
}

async function executable(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return false;
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidates(name: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [name];
  if (/\.(?:exe|cmd|bat)$/iu.test(name)) return [name];
  return [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name];
}

export interface ExecutableResolverOptions {
  workspaceRoot: string;
  path?: string;
  platform?: NodeJS.Platform;
}

export class ExecutableResolver {
  private readonly platform: NodeJS.Platform;
  private readonly pathValue: string;

  public constructor(private readonly options: ExecutableResolverOptions) {
    this.platform = options.platform ?? process.platform;
    this.pathValue = options.path ?? process.env.PATH ?? "";
  }

  public async resolve(name: string): Promise<ExecutableInfo> {
    const normalized = basename(name)
      .replace(/\.(?:exe|cmd|bat)$/iu, "")
      .toLowerCase();
    if (!KNOWN_EXECUTABLES.has(normalized) || name.includes("\0")) {
      return { name, available: false, source: "unknown" };
    }
    const root = await realpath(resolve(this.options.workspaceRoot));
    const localDirectories = [
      [join(root, "node_modules", ".bin"), "node_modules_bin"],
      [join(root, ".venv", this.platform === "win32" ? "Scripts" : "bin"), "workspace"],
      [join(root, "venv", this.platform === "win32" ? "Scripts" : "bin"), "workspace"],
      [root, "workspace"],
    ] as const;
    for (const [directory, source] of localDirectories) {
      if (directory === root && !["mvnw", "gradlew"].includes(normalized)) continue;
      for (const candidate of candidates(name, this.platform)) {
        const path = join(directory, candidate);
        if (!(await executable(path))) continue;
        const canonical = await realpath(path);
        if (outside(root, canonical)) continue;
        return { name, available: true, resolvedPath: path, source };
      }
    }
    const pathSeparator =
      this.platform === process.platform ? delimiter : this.platform === "win32" ? ";" : ":";
    for (const directory of this.pathValue.split(pathSeparator).filter(Boolean)) {
      for (const candidate of candidates(name, this.platform)) {
        const path = join(directory, candidate);
        if (await executable(path))
          return { name, available: true, resolvedPath: path, source: "path" };
      }
    }
    return { name, available: false, source: "unknown" };
  }

  public async detect(names: readonly string[]): Promise<ExecutableInfo[]> {
    return Promise.all(names.map((name) => this.resolve(name)));
  }
}

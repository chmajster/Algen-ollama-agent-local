import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import {
  PackageManagerDetector,
  type CommandCategory,
  type CommandSpec,
  type ExecutableResolver,
} from "@local-code-agent/command-runner";

import type {
  DetectedProjectCommand,
  ProjectCommandCatalog,
  ProjectVerifierOptions,
} from "./verifierTypes.js";

const SAFE_SCRIPT =
  /^(?:test(?::(?:unit|integration|ci))?|lint(?::check)?|typecheck|type-check|check|build|format(?::check)?)$/iu;
const BLOCKED_SCRIPT =
  /(?:deploy|release|publish|upload|push|production|prod|migrate|seed|reset|drop|clean|destroy|infrastructure|terraform|ansible|ssh|remote|start|serve|dev|watch)/iu;
const UNSAFE_SCRIPT_TEXT =
  /(?:&&|\|\||;|`|\$\(|\.\.[\\/]|https?:\/\/|\bcurl\b|\bwget\b|\brm\b|\bdel\b|\bpublish\b|\bdeploy\b|\bwatch\b)/iu;

interface PackageJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<PackageJson | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return typeof value === "object" && value !== null ? (value as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

function offlineEnvironment(projectType: string): Record<string, string> {
  if (projectType === "python") return { PIP_NO_INDEX: "1" };
  if (projectType === "rust") return { CARGO_NET_OFFLINE: "true" };
  if (projectType === "go") return { GOPROXY: "off", GONOSUMDB: "*" };
  if (projectType === "php") return { COMPOSER_DISABLE_NETWORK: "1" };
  if (projectType === "dotnet") return { DOTNET_NOLOGO: "1" };
  return {};
}

function categoryForScript(name: string): CommandCategory {
  if (name.startsWith("test")) return "test";
  if (name.startsWith("lint")) return "lint";
  if (["typecheck", "type-check", "check"].includes(name)) return "typecheck";
  if (name === "build") return "build";
  if (name.startsWith("format")) return "format";
  return "diagnostic";
}

function timeoutFor(category: CommandCategory, options: ProjectVerifierOptions): number {
  if (category === "test") return options.testTimeoutMs;
  if (category === "build") return options.buildTimeoutMs;
  if (category === "typecheck") return Math.min(options.buildTimeoutMs, 180_000);
  if (category === "version") return 10_000;
  if (category === "diagnostic") return Math.min(options.commandTimeoutMs, 30_000);
  return options.commandTimeoutMs;
}

function commandView(
  spec: CommandSpec,
  allowed: boolean,
  blockedReasons: string[],
): DetectedProjectCommand {
  return {
    id: spec.id,
    category: spec.category as DetectedProjectCommand["category"],
    displayName: spec.displayName ?? spec.id,
    executable: spec.executable,
    args: [...spec.args],
    cwd: spec.cwd,
    source: spec.source,
    risk: allowed ? (spec.writesFiles ? "medium" : "safe") : "blocked",
    allowed,
    blockedReasons,
    writesFiles: spec.writesFiles,
  };
}

export class ProjectScriptDetector {
  public constructor(
    private readonly options: ProjectVerifierOptions,
    private readonly resolver: ExecutableResolver,
  ) {}

  private async nodePackageDirectories(rootPackage: PackageJson): Promise<string[]> {
    const result = [this.options.workspaceRoot];
    const patterns = Array.isArray(rootPackage.workspaces)
      ? rootPackage.workspaces
      : (rootPackage.workspaces?.packages ?? []);
    for (const pattern of patterns) {
      if (!pattern.endsWith("/*")) continue;
      const parent = join(this.options.workspaceRoot, pattern.slice(0, -2));
      try {
        for (const entry of await readdir(parent, { withFileTypes: true })) {
          if (entry.isDirectory() && (await fileExists(join(parent, entry.name, "package.json")))) {
            result.push(join(parent, entry.name));
          }
        }
      } catch {
        // Nieistniejący wzorzec workspace jest tylko pomijany.
      }
    }
    return [...new Set(result)];
  }

  private async addNodeCommands(
    commands: DetectedProjectCommand[],
    specs: Map<string, CommandSpec>,
    projectTypes: Set<string>,
    warnings: string[],
  ): Promise<void> {
    const rootPackage = await readJson(join(this.options.workspaceRoot, "package.json"));
    if (rootPackage === undefined) return;
    projectTypes.add("node");
    const manager = await new PackageManagerDetector(
      this.options.workspaceRoot,
      this.resolver,
    ).detect();
    if (manager.type === "unknown") {
      warnings.push(
        ...manager.warnings,
        "Nie można jednoznacznie wybrać menedżera pakietów dla skryptów Node.js.",
      );
      return;
    }
    const executable = await this.resolver.resolve(manager.type);
    for (const directory of await this.nodePackageDirectories(rootPackage)) {
      const manifest = await readJson(join(directory, "package.json"));
      for (const [name, scriptText] of Object.entries(manifest?.scripts ?? {})) {
        if (!SAFE_SCRIPT.test(name) && !BLOCKED_SCRIPT.test(name)) continue;
        const category = categoryForScript(name);
        const relativePackage =
          relative(this.options.workspaceRoot, directory).replaceAll("\\", "/") || ".";
        const id = `node:${relativePackage}:${name}`;
        const writesFiles = category === "format" && !name.includes("check");
        const spec: CommandSpec = {
          id,
          category,
          executable: executable.resolvedPath ?? manager.type,
          args: ["run", name],
          cwd: directory,
          timeoutMs: timeoutFor(category, this.options),
          environment: {
            CI: "true",
            NO_COLOR: "1",
            NPM_CONFIG_OFFLINE: "true",
            YARN_ENABLE_NETWORK: "false",
          },
          networkAccess: false,
          writesFiles,
          source: "detected_script",
          displayName: `${manifest?.name ?? basename(directory)} — ${name}`,
          scriptText,
        };
        const blockedReasons: string[] = [];
        if (!executable.available)
          blockedReasons.push(`Program ${manager.type} nie jest dostępny.`);
        if (!SAFE_SCRIPT.test(name) || BLOCKED_SCRIPT.test(name))
          blockedReasons.push("Nazwa skryptu jest niedozwolona w polityce verification.");
        if (UNSAFE_SCRIPT_TEXT.test(scriptText))
          blockedReasons.push("Treść skryptu jest niejednoznaczna lub niebezpieczna.");
        if (writesFiles)
          blockedReasons.push(
            "Formatter modyfikujący pliki wymaga transakcji zmian; dozwolony jest tylko tryb check.",
          );
        const allowed = blockedReasons.length === 0;
        commands.push(commandView(spec, allowed, blockedReasons));
        if (allowed) specs.set(id, spec);
      }
    }
  }

  private async addDirect(
    commands: DetectedProjectCommand[],
    specs: Map<string, CommandSpec>,
    projectTypes: Set<string>,
    input: {
      projectType: string;
      evidence: string;
      executable: string;
      category: DetectedProjectCommand["category"];
      args: readonly string[];
      id: string;
      name: string;
      environment?: Record<string, string>;
      scriptText?: string;
      requireSafeScript?: boolean;
    },
  ): Promise<void> {
    if (!(await fileExists(join(this.options.workspaceRoot, input.evidence)))) return;
    projectTypes.add(input.projectType);
    const executable = await this.resolver.resolve(input.executable);
    const spec: CommandSpec = {
      id: input.id,
      category: input.category,
      executable: executable.resolvedPath ?? input.executable,
      args: [...input.args],
      cwd: this.options.workspaceRoot,
      timeoutMs: timeoutFor(input.category, this.options),
      environment: { ...offlineEnvironment(input.projectType), ...input.environment },
      networkAccess: false,
      writesFiles: false,
      source: input.scriptText === undefined ? "built_in" : "detected_script",
      displayName: input.name,
      ...(input.scriptText === undefined ? {} : { scriptText: input.scriptText }),
    };
    const blockedReasons = executable.available
      ? []
      : [`Program ${input.executable} nie jest dostępny.`];
    if (input.requireSafeScript && input.scriptText === undefined) {
      blockedReasons.push("Projekt nie definiuje wymaganego skryptu.");
    }
    if (input.scriptText !== undefined && UNSAFE_SCRIPT_TEXT.test(input.scriptText)) {
      blockedReasons.push("Treść skryptu jest niejednoznaczna lub niebezpieczna.");
    }
    const allowed = blockedReasons.length === 0;
    commands.push(commandView(spec, allowed, blockedReasons));
    if (allowed) specs.set(spec.id, spec);
  }

  public async detect(): Promise<ProjectCommandCatalog> {
    const commands: DetectedProjectCommand[] = [];
    const specs = new Map<string, CommandSpec>();
    const projectTypes = new Set<string>();
    const warnings: string[] = [];
    await this.addNodeCommands(commands, specs, projectTypes, warnings);
    const composer = await readJson(join(this.options.workspaceRoot, "composer.json"));
    const composerTest = composer?.scripts?.test;
    let dotnetEvidence = "global.json";
    if (!(await fileExists(join(this.options.workspaceRoot, dotnetEvidence)))) {
      try {
        dotnetEvidence =
          (await readdir(this.options.workspaceRoot)).find(
            (entry) => entry.endsWith(".sln") || entry.endsWith(".csproj"),
          ) ?? ".missing-dotnet-project";
      } catch {
        dotnetEvidence = ".missing-dotnet-project";
      }
    }
    const direct = [
      {
        projectType: "python",
        evidence: "pyproject.toml",
        executable: "ruff",
        category: "format",
        args: ["format", "--check", "."],
        id: "python:ruff-format",
        name: "Ruff format check",
      },
      {
        projectType: "python",
        evidence: "pyproject.toml",
        executable: "ruff",
        category: "lint",
        args: ["check", "."],
        id: "python:ruff",
        name: "Ruff check",
      },
      {
        projectType: "python",
        evidence: "pyproject.toml",
        executable: "mypy",
        category: "typecheck",
        args: ["."],
        id: "python:mypy",
        name: "Mypy",
      },
      {
        projectType: "python",
        evidence: "pyproject.toml",
        executable: "pytest",
        category: "test",
        args: [],
        id: "python:pytest",
        name: "Pytest",
      },
      {
        projectType: "rust",
        evidence: "Cargo.toml",
        executable: "cargo",
        category: "format",
        args: ["fmt", "--check"],
        id: "rust:fmt",
        name: "Cargo fmt check",
      },
      {
        projectType: "rust",
        evidence: "Cargo.toml",
        executable: "cargo",
        category: "lint",
        args: ["clippy", "--", "-D", "warnings"],
        id: "rust:clippy",
        name: "Cargo clippy",
      },
      {
        projectType: "rust",
        evidence: "Cargo.toml",
        executable: "cargo",
        category: "test",
        args: ["test"],
        id: "rust:test",
        name: "Cargo test",
      },
      {
        projectType: "rust",
        evidence: "Cargo.toml",
        executable: "cargo",
        category: "build",
        args: ["build"],
        id: "rust:build",
        name: "Cargo build",
      },
      {
        projectType: "go",
        evidence: "go.mod",
        executable: "go",
        category: "test",
        args: ["test", "./..."],
        id: "go:test",
        name: "Go test",
        environment: { GOPROXY: "off", GONOSUMDB: "*" },
      },
      {
        projectType: "go",
        evidence: "go.mod",
        executable: "go",
        category: "lint",
        args: ["vet", "./..."],
        id: "go:vet",
        name: "Go vet",
        environment: { GOPROXY: "off", GONOSUMDB: "*" },
      },
      {
        projectType: "go",
        evidence: "go.mod",
        executable: "go",
        category: "build",
        args: ["build", "./..."],
        id: "go:build",
        name: "Go build",
        environment: { GOPROXY: "off", GONOSUMDB: "*" },
      },
      {
        projectType: "dotnet",
        evidence: dotnetEvidence,
        executable: "dotnet",
        category: "format",
        args: ["format", "--verify-no-changes", "--no-restore"],
        id: "dotnet:format-check",
        name: ".NET format check",
      },
      {
        projectType: "dotnet",
        evidence: dotnetEvidence,
        executable: "dotnet",
        category: "test",
        args: ["test", "--no-restore"],
        id: "dotnet:test",
        name: ".NET test",
      },
      {
        projectType: "dotnet",
        evidence: dotnetEvidence,
        executable: "dotnet",
        category: "build",
        args: ["build", "--no-restore"],
        id: "dotnet:build",
        name: ".NET build",
      },
      {
        projectType: "php",
        evidence: "composer.json",
        executable: "composer",
        category: "test",
        args: ["test", "--", "--no-interaction"],
        id: "php:test",
        name: "Composer test",
        ...(composerTest === undefined ? {} : { scriptText: composerTest }),
        requireSafeScript: true,
      },
    ] as const;
    for (const input of direct) await this.addDirect(commands, specs, projectTypes, input);

    if (await fileExists(join(this.options.workspaceRoot, "mvnw"))) {
      await this.addDirect(commands, specs, projectTypes, {
        projectType: "java",
        evidence: "mvnw",
        executable: "mvnw",
        category: "test",
        args: ["test", "-o"],
        id: "java:mvn-test",
        name: "Maven wrapper test",
      });
      await this.addDirect(commands, specs, projectTypes, {
        projectType: "java",
        evidence: "mvnw",
        executable: "mvnw",
        category: "build",
        args: ["verify", "-o"],
        id: "java:mvn-build",
        name: "Maven wrapper verify",
      });
    } else {
      await this.addDirect(commands, specs, projectTypes, {
        projectType: "java",
        evidence: "pom.xml",
        executable: "mvn",
        category: "test",
        args: ["test", "-o"],
        id: "java:mvn-test",
        name: "Maven test",
      });
      await this.addDirect(commands, specs, projectTypes, {
        projectType: "java",
        evidence: "pom.xml",
        executable: "mvn",
        category: "build",
        args: ["verify", "-o"],
        id: "java:mvn-build",
        name: "Maven verify",
      });
    }
    if (await fileExists(join(this.options.workspaceRoot, "gradlew"))) {
      await this.addDirect(commands, specs, projectTypes, {
        projectType: "java",
        evidence: "gradlew",
        executable: "gradlew",
        category: "test",
        args: ["test", "--offline", "--no-daemon"],
        id: "java:gradle-test",
        name: "Gradle wrapper test",
      });
      await this.addDirect(commands, specs, projectTypes, {
        projectType: "java",
        evidence: "gradlew",
        executable: "gradlew",
        category: "build",
        args: ["build", "--offline", "--no-daemon"],
        id: "java:gradle-build",
        name: "Gradle wrapper build",
      });
    }

    const packageManager = projectTypes.has("node")
      ? await new PackageManagerDetector(this.options.workspaceRoot, this.resolver).detect()
      : undefined;
    const hash = createHash("sha256");
    const hashRootPackage = await readJson(join(this.options.workspaceRoot, "package.json"));
    const workspaceManifests =
      hashRootPackage === undefined
        ? []
        : (await this.nodePackageDirectories(hashRootPackage)).map((directory) =>
            relative(this.options.workspaceRoot, join(directory, "package.json")),
          );
    const configurationFiles = [
      "package.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "pyproject.toml",
      "Cargo.toml",
      "go.mod",
      "pom.xml",
      "composer.json",
      "global.json",
      "gradlew",
      "mvnw",
      ...workspaceManifests,
    ];
    if (dotnetEvidence !== ".missing-dotnet-project") configurationFiles.push(dotnetEvidence);
    for (const file of [...new Set(configurationFiles)]) {
      try {
        hash.update(file).update(await readFile(join(this.options.workspaceRoot, file)));
      } catch {
        // Brak pliku nie wnosi dowodu.
      }
    }
    return {
      detection: {
        projectType: [...projectTypes].sort(),
        ...(packageManager === undefined ? {} : { packageManager }),
        commands: commands.sort((left, right) => left.id.localeCompare(right.id)),
        warnings: [...new Set([...warnings, ...(packageManager?.warnings ?? [])])],
        configurationHash: hash.digest("hex"),
      },
      specs,
    };
  }
}

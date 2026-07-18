import { basename, extname } from "node:path";

import type {
  DetectedTechnology,
  ProjectTechnologyResult,
  TechnologyConfidence,
} from "./workspaceTypes.js";

export interface TechnologyDetectionInput {
  files: string[];
  readSmallText(path: string): Promise<string | undefined>;
}

const CONFIDENCE_ORDER: Readonly<Record<TechnologyConfidence, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export async function detectTechnologies(
  input: TechnologyDetectionInput,
): Promise<ProjectTechnologyResult> {
  const detected = new Map<string, DetectedTechnology>();
  const files = input.files.map((path) => path.replaceAll("\\", "/"));
  const lowerFiles = files.map((path) => path.toLowerCase());

  const add = (name: string, confidence: TechnologyConfidence, evidence: string): void => {
    const existing = detected.get(name);
    if (existing === undefined) {
      detected.set(name, { name, confidence, evidence: [evidence] });
      return;
    }
    if (!existing.evidence.includes(evidence)) {
      existing.evidence.push(evidence);
    }
    if (CONFIDENCE_ORDER[confidence] > CONFIDENCE_ORDER[existing.confidence]) {
      existing.confidence = confidence;
    }
  };

  const fileWithName = (names: readonly string[]): string | undefined =>
    files.find((path) => names.includes(basename(path).toLowerCase()));
  const filesWithExtension = (extensions: readonly string[]): string[] =>
    files.filter((path) => extensions.includes(extname(path).toLowerCase()));

  for (const packagePath of files.filter(
    (path) => basename(path).toLowerCase() === "package.json",
  )) {
    const content = await input.readSmallText(packagePath);
    if (content === undefined) {
      continue;
    }
    let packageJson: unknown;
    try {
      packageJson = JSON.parse(content) as unknown;
    } catch {
      continue;
    }
    if (typeof packageJson !== "object" || packageJson === null) {
      continue;
    }
    const record = packageJson as Record<string, unknown>;
    const dependencyNames = new Set<string>();
    for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const dependencies = record[field];
      if (typeof dependencies === "object" && dependencies !== null) {
        Object.keys(dependencies).forEach((dependency) => dependencyNames.add(dependency));
      }
    }
    add("Node.js", "high", packagePath);
    const packageTechnologies: ReadonlyArray<[string, string]> = [
      ["typescript", "TypeScript"],
      ["react", "React"],
      ["vue", "Vue"],
      ["@angular/core", "Angular"],
      ["next", "Next.js"],
      ["nuxt", "Nuxt"],
      ["express", "Express"],
      ["@nestjs/core", "NestJS"],
    ];
    for (const [dependency, technology] of packageTechnologies) {
      if (dependencyNames.has(dependency)) {
        add(technology, "high", `${packagePath} zawiera zależność ${dependency}`);
      }
    }
  }

  const configEvidence: ReadonlyArray<[string, readonly string[], string]> = [
    ["TypeScript", ["tsconfig.json", "tsconfig.base.json"], "high"],
    ["Maven", ["pom.xml"], "high"],
    ["Gradle", ["build.gradle", "build.gradle.kts", "settings.gradle"], "high"],
    ["Go", ["go.mod"], "high"],
    ["Rust", ["cargo.toml"], "high"],
    ["Composer", ["composer.json"], "high"],
    ["Docker", ["dockerfile"], "high"],
    [
      "Docker Compose",
      ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
      "high",
    ],
    ["Ansible", ["ansible.cfg"], "high"],
    ["GitLab CI", [".gitlab-ci.yml", ".gitlab-ci.yaml"], "high"],
  ];
  for (const [technology, names, confidence] of configEvidence) {
    const evidence = fileWithName(names);
    if (evidence !== undefined) {
      add(technology, confidence as TechnologyConfidence, evidence);
    }
  }

  const extensionEvidence: ReadonlyArray<[string, readonly string[]]> = [
    ["TypeScript", [".ts", ".tsx"]],
    ["JavaScript", [".js", ".jsx", ".mjs", ".cjs"]],
    ["Python", [".py"]],
    ["Java", [".java"]],
    ["Kotlin", [".kt", ".kts"]],
    ["Go", [".go"]],
    ["Rust", [".rs"]],
    ["PHP", [".php"]],
    [".NET", [".cs", ".fs", ".vb", ".csproj", ".fsproj", ".sln"]],
    ["Terraform", [".tf"]],
    ["PowerShell", [".ps1", ".psm1"]],
    ["Bash", [".sh", ".bash"]],
  ];
  for (const [technology, extensions] of extensionEvidence) {
    const evidence = filesWithExtension(extensions)[0];
    if (evidence !== undefined) {
      add(technology, "medium", evidence);
    }
  }

  const requirements = files.filter((path) => {
    const name = basename(path).toLowerCase();
    return name === "requirements.txt" || name === "pyproject.toml";
  });
  for (const path of requirements) {
    const content = (await input.readSmallText(path))?.toLowerCase();
    if (content === undefined) {
      continue;
    }
    add("Python", "high", path);
    for (const [needle, name] of [
      ["django", "Django"],
      ["flask", "Flask"],
      ["fastapi", "FastAPI"],
    ] as const) {
      if (content.includes(needle)) {
        add(name, "high", `${path} zawiera ${needle}`);
      }
    }
  }

  const composerPath = fileWithName(["composer.json"]);
  if (composerPath !== undefined) {
    const composer = (await input.readSmallText(composerPath))?.toLowerCase() ?? "";
    if (composer.includes("laravel/framework")) {
      add("Laravel", "high", `${composerPath} zawiera laravel/framework`);
    }
    if (composer.includes("symfony/")) {
      add("Symfony", "high", `${composerPath} zawiera pakiet Symfony`);
    }
  }

  const githubWorkflow = files.find((path) => path.toLowerCase().startsWith(".github/workflows/"));
  if (githubWorkflow !== undefined) {
    add("GitHub Actions", "high", githubWorkflow);
  }

  const dockerfile = lowerFiles.findIndex((path) => basename(path) === "dockerfile");
  if (dockerfile >= 0) {
    add("Docker", "high", files[dockerfile] ?? "Dockerfile");
  }

  return {
    technologies: [...detected.values()]
      .map((technology) => ({
        ...technology,
        evidence: technology.evidence.sort((left, right) => left.localeCompare(right)),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

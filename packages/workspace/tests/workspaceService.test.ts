import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileTooLargeError,
  InvalidLineRangeError,
  LocalWorkspaceService,
  SearchPatternError,
  SensitiveFileAccessError,
  UnsupportedEncodingError,
} from "../src/index.js";
import type { GitCommandRunner, WorkspaceServiceOptions } from "../src/index.js";

let root: string;

const nonRepositoryRunner: GitCommandRunner = {
  async run(): Promise<never> {
    throw new Error("not a repository");
  },
};

async function addFile(relativePath: string, content: string | Uint8Array): Promise<void> {
  const absolute = join(root, ...relativePath.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function service(
  overrides: Partial<WorkspaceServiceOptions> = {},
): Promise<LocalWorkspaceService> {
  return LocalWorkspaceService.create({
    root,
    maxFileSizeBytes: 1_048_576,
    maxReadLines: 1_000,
    maxSearchResults: 100,
    maxDirectoryDepth: 12,
    includeHiddenFiles: false,
    respectGitignore: true,
    allowSensitiveFiles: false,
    gitRunner: nonRepositoryRunner,
    ...overrides,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workspace-service-"));
  await addFile("src/index.ts", "first line\nUserService starts here\nthird line\nfourth line\n");
  await addFile("src/nested/helper.ts", "export const helper = 'HELLO';\n");
  await addFile("tests/index.test.ts", "describe('UserService', () => {});\n");
  await addFile("README.md", "# Sample\nHello world\n");
  await addFile("package.json", '{"name":"sample","devDependencies":{"typescript":"^5.9.3"}}');
  await addFile("tsconfig.json", '{"compilerOptions":{"strict":true}}');
  await addFile(".gitignore", "ignored.txt\nignored-dir/\n");
  await addFile("ignored.txt", "UserService ignored\n");
  await addFile("ignored-dir/file.ts", "ignored\n");
  await addFile("node_modules/library/index.js", "module.exports = {};\n");
  await addFile(".hidden.ts", "hidden\n");
  await addFile(".env", "TOKEN=fixture-only\n");
  await addFile(".env.example", "TOKEN=replace-me\n");
  await addFile("assets/data.txt", Uint8Array.from([65, 0, 66]));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("WorkspaceService — odczyt plików", () => {
  it("odczytuje mały plik UTF-8", async () => {
    const result = await (await service()).readFile({ path: "README.md" });
    expect(result).toMatchObject({ binary: false, path: "README.md", totalLines: 2 });
    if (!result.binary) expect(result.content).toContain("Hello world");
  });

  it("usuwa BOM z pliku UTF-8", async () => {
    await addFile(
      "bom.txt",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("treść")]),
    );
    const result = await (await service()).readFile({ path: "bom.txt" });
    if (!result.binary) expect(result.content).toBe("treść");
  });

  it("zwraca prawidłowe numery pierwszej i ostatniej linii", async () => {
    const result = await (await service()).readFile({ path: "src/index.ts" });
    expect(result).toMatchObject({ startLine: 1, endLine: 4, totalLines: 4 });
  });

  it("zwraca SHA-256 pełnej surowej zawartości dla pełnego odczytu i zakresu", async () => {
    const raw = Buffer.from("first\r\nsecond\r\n", "utf8");
    await addFile("raw.txt", raw);
    const expected = createHash("sha256").update(raw).digest("hex");
    const workspace = await service();
    await expect(workspace.readFile({ path: "raw.txt" })).resolves.toMatchObject({
      sha256: expected,
    });
    await expect(
      workspace.readFileRange({ path: "raw.txt", startLine: 2, endLine: 2 }),
    ).resolves.toMatchObject({ sha256: expected });
  });

  it("odczytuje zakres linii strumieniowo", async () => {
    const result = await (
      await service()
    ).readFileRange({
      path: "src/index.ts",
      startLine: 2,
      endLine: 3,
    });
    expect(result).toMatchObject({ startLine: 2, endLine: 3, totalLines: 4 });
    if (!result.binary) expect(result.content).toBe("UserService starts here\nthird line\n");
  });

  it("ogranicza zakres wychodzący poza plik", async () => {
    const result = await (
      await service()
    ).readFileRange({
      path: "README.md",
      startLine: 2,
      endLine: 20,
    });
    expect(result).toMatchObject({ startLine: 2, endLine: 2, totalLines: 2 });
  });

  it("odrzuca odwrócony zakres", async () => {
    await expect(
      (await service()).readFileRange({ path: "README.md", startLine: 3, endLine: 2 }),
    ).rejects.toBeInstanceOf(InvalidLineRangeError);
  });

  it("odrzuca zakres przekraczający limit linii", async () => {
    await expect(
      (await service({ maxReadLines: 2 })).readFileRange({
        path: "README.md",
        startLine: 1,
        endLine: 3,
      }),
    ).rejects.toBeInstanceOf(InvalidLineRangeError);
  });

  it("skraca pełny odczyt do limitu linii", async () => {
    const result = await (await service({ maxReadLines: 2 })).readFile({ path: "src/index.ts" });
    expect(result).toMatchObject({ truncated: true, endLine: 2, totalLines: 4 });
  });

  it("blokuje pełny odczyt zbyt dużego pliku", async () => {
    await expect(
      (await service({ maxFileSizeBytes: 10 })).readFile({ path: "README.md" }),
    ).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it("ogranicza pamięć zakresu dla bardzo długiej pojedynczej linii", async () => {
    await addFile("long-line.txt", "x".repeat(10_000));
    const result = await (
      await service({ maxFileSizeBytes: 100 })
    ).readFileRange({
      path: "long-line.txt",
      startLine: 1,
      endLine: 1,
    });
    expect(result).toMatchObject({ binary: false, totalLines: 1, truncated: true });
    if (!result.binary) expect(result.content.length).toBeLessThanOrEqual(100);
  });

  it("wykrywa plik binarny bez kodowania Base64", async () => {
    const result = await (await service()).readFile({ path: "assets/data.txt" });
    expect(result).toMatchObject({ binary: true, message: expect.stringContaining("binarny") });
    expect(result).not.toHaveProperty("content");
  });

  it("odrzuca tekst w nieobsługiwanym kodowaniu", async () => {
    await addFile("legacy.txt", Uint8Array.from([0xc3, 0x28]));
    await expect((await service()).readFile({ path: "legacy.txt" })).rejects.toBeInstanceOf(
      UnsupportedEncodingError,
    );
  });

  it("blokuje plik .env", async () => {
    await expect((await service()).readFile({ path: ".env" })).rejects.toBeInstanceOf(
      SensitiveFileAccessError,
    );
  });

  it("zezwala na .env.example", async () => {
    const result = await (await service()).readFile({ path: ".env.example" });
    expect(result.binary).toBe(false);
  });

  it("pozwala jawnie odczytać plik ignorowany przez .gitignore", async () => {
    const result = await (await service()).readFile({ path: "ignored.txt" });
    expect(result.binary).toBe(false);
  });

  it("pozwala świadomie włączyć dostęp do plików poufnych", async () => {
    const result = await (await service({ allowSensitiveFiles: true })).readFile({ path: ".env" });
    expect(result.binary).toBe(false);
  });
});

describe("WorkspaceService — listowanie", () => {
  it("listuje pojedynczy poziom katalogu", async () => {
    const result = await (await service()).listFiles();
    expect(result.entries.some((entry) => entry.path === "src")).toBe(true);
    expect(result.entries.some((entry) => entry.path === "src/index.ts")).toBe(false);
  });

  it("listuje rekursywnie", async () => {
    const result = await (await service()).listFiles({ recursive: true, maxDepth: 4 });
    expect(result.entries.some((entry) => entry.path === "src/nested/helper.ts")).toBe(true);
  });

  it("respektuje limit głębokości", async () => {
    const result = await (await service()).listFiles({ recursive: true, maxDepth: 1 });
    expect(result.entries.some((entry) => entry.path === "src/index.ts")).toBe(false);
  });

  it("filtruje rozszerzenia", async () => {
    const result = await (
      await service()
    ).listFiles({
      recursive: true,
      maxDepth: 4,
      includeDirectories: false,
      extensions: ["md"],
    });
    expect(result.entries.map((entry) => entry.path)).toEqual(["README.md"]);
  });

  it("pomija .git niezależnie od konfiguracji", async () => {
    await addFile(".git/config", "fixture\n");
    const result = await (
      await service({ includeHiddenFiles: true })
    ).listFiles({ recursive: true });
    expect(
      result.entries.some((entry) => entry.path === ".git" || entry.path.startsWith(".git/")),
    ).toBe(false);
  });

  it("pomija node_modules", async () => {
    const result = await (await service()).listFiles({ recursive: true, maxDepth: 8 });
    expect(result.entries.some((entry) => entry.path.includes("node_modules"))).toBe(false);
  });

  it("respektuje .gitignore", async () => {
    const result = await (await service()).listFiles({ recursive: true, maxDepth: 8 });
    expect(result.entries.some((entry) => entry.path.startsWith("ignored"))).toBe(false);
  });

  it("pokazuje plik ignorowany po wyłączeniu .gitignore", async () => {
    const result = await (
      await service({ respectGitignore: false })
    ).listFiles({
      recursive: true,
      maxDepth: 8,
    });
    expect(result.entries.some((entry) => entry.path === "ignored.txt")).toBe(true);
  });

  it("domyślnie ukrywa pliki ukryte", async () => {
    const result = await (await service()).listFiles();
    expect(result.entries.some((entry) => entry.path === ".hidden.ts")).toBe(false);
  });

  it("uwzględnia ukryte pliki po włączeniu konfiguracji", async () => {
    const result = await (await service({ includeHiddenFiles: true })).listFiles();
    expect(result.entries.some((entry) => entry.path === ".hidden.ts")).toBe(true);
  });

  it("sortuje katalogi przed plikami", async () => {
    const result = await (await service()).listFiles();
    const firstFile = result.entries.findIndex((entry) => entry.type === "file");
    const lastDirectory = result.entries.findLastIndex((entry) => entry.type === "directory");
    expect(lastDirectory).toBeLessThan(firstFile);
  });
});

describe("WorkspaceService — wyszukiwanie i znajdowanie", () => {
  it("wyszukuje zwykły tekst", async () => {
    const result = await (await service()).searchText({ query: "UserService" });
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
  });

  it("domyślnie ignoruje wielkość liter", async () => {
    const result = await (await service()).searchText({ query: "hello" });
    expect(result.matches.some((match) => match.path === "README.md")).toBe(true);
    expect(result.matches.some((match) => match.path === "src/nested/helper.ts")).toBe(true);
  });

  it("wyszukuje całe słowa", async () => {
    const result = await (await service()).searchText({ query: "User", wholeWord: true });
    expect(result.matches).toHaveLength(0);
  });

  it("obsługuje poprawne wyrażenie regularne", async () => {
    const result = await (
      await service()
    ).searchText({
      query: "User(Service)?",
      useRegex: true,
      caseSensitive: true,
    });
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("odrzuca błędne wyrażenie regularne", async () => {
    await expect(
      (await service()).searchText({ query: "[", useRegex: true }),
    ).rejects.toBeInstanceOf(SearchPatternError);
  });

  it("odrzuca potencjalnie kosztowne wyrażenie regularne", async () => {
    await expect(
      (await service()).searchText({ query: "(a+)+$", useRegex: true }),
    ).rejects.toBeInstanceOf(SearchPatternError);
  });

  it("zatrzymuje się na limicie wyników", async () => {
    const result = await (await service()).searchText({ query: "line", maxResults: 1 });
    expect(result).toMatchObject({ truncated: true });
    expect(result.matches).toHaveLength(1);
  });

  it("zwraca linie kontekstu", async () => {
    const result = await (
      await service()
    ).searchText({
      query: "UserService starts",
      contextLines: 1,
    });
    expect(result.matches[0]).toMatchObject({ before: ["first line"], after: ["third line"] });
  });

  it("pomija pliki binarne", async () => {
    const result = await (await service()).searchText({ query: "A" });
    expect(result.matches.some((match) => match.path === "assets/data.txt")).toBe(false);
    expect(result.skippedFiles).toBeGreaterThan(0);
  });

  it("pomija pliki chronione nawet po włączeniu plików ukrytych", async () => {
    const result = await (
      await service({ includeHiddenFiles: true })
    ).searchText({
      query: "fixture-only",
    });
    expect(result.matches).toHaveLength(0);
  });

  it("odnajduje dokładną nazwę pliku", async () => {
    const result = await (await service()).findFiles({ name: "package.json" });
    expect(result.files.map((file) => file.path)).toContain("package.json");
  });

  it("odnajduje częściową nazwę bez rozróżniania wielkości liter", async () => {
    const result = await (await service()).findFiles({ name: "read" });
    expect(result.files.map((file) => file.path)).toContain("README.md");
  });

  it("obsługuje prosty glob", async () => {
    const result = await (await service()).findFiles({ pattern: "**/*.test.ts" });
    expect(result.files.map((file) => file.path)).toEqual(["tests/index.test.ts"]);
  });

  it("blokuje glob z traversal", async () => {
    await expect((await service()).findFiles({ pattern: "../**/*" })).rejects.toBeInstanceOf(
      SearchPatternError,
    );
  });
});

describe("WorkspaceService — mapa i technologie", () => {
  it("analizuje izolowany fixture przykładowego projektu", async () => {
    const fixture = fileURLToPath(
      new URL("../../../tests/fixtures/sample-project", import.meta.url),
    );
    await rm(root, { recursive: true, force: true });
    await cp(fixture, root, { recursive: true });
    await addFile("ignored.txt", "UserService ignored\n");
    const workspace = await service();

    const files = await workspace.listFiles({ recursive: true, maxDepth: 5 });
    expect(files.entries.some((entry) => entry.path === "src/auth.ts")).toBe(true);
    expect(files.entries.some((entry) => entry.path === "ignored.txt")).toBe(false);
    await expect(workspace.readFile({ path: ".env" })).rejects.toBeInstanceOf(
      SensitiveFileAccessError,
    );
    await expect(workspace.readFile({ path: ".env.example" })).resolves.toMatchObject({
      binary: false,
    });
    const search = await workspace.searchText({ query: "UserService" });
    expect(search.matches.some((match) => match.path === "src/auth.ts")).toBe(true);
    const technologies = await workspace.detectProjectTechnologies();
    expect(technologies.technologies.map((technology) => technology.name)).toEqual(
      expect.arrayContaining(["Node.js", "TypeScript"]),
    );
  });

  it("generuje tekstową mapę repozytorium", async () => {
    const result = await (await service()).getRepositoryMap({ maxDepth: 4 });
    expect(result.map).toContain("├── src");
    expect(result.map).toContain("index.ts");
  });

  it("podsumowuje liczbę plików i katalogów", async () => {
    const result = await (await service()).getRepositoryMap({ maxDepth: 4 });
    expect(result.files).toBeGreaterThan(3);
    expect(result.directories).toBeGreaterThan(1);
  });

  it("podsumowuje wykryte języki", async () => {
    const result = await (await service()).getRepositoryMap({ maxDepth: 4 });
    expect(result.languages.TypeScript).toBeGreaterThan(0);
  });

  it("wykrywa TypeScript i Node.js na podstawie dowodów", async () => {
    const result = await (await service()).detectProjectTechnologies();
    expect(result.technologies.map((technology) => technology.name)).toEqual(
      expect.arrayContaining(["Node.js", "TypeScript"]),
    );
  });

  it("wykrywa Dockera po dodaniu Dockerfile", async () => {
    await addFile("Dockerfile", "FROM node:22\n");
    const result = await (await service()).detectProjectTechnologies();
    expect(result.technologies.map((technology) => technology.name)).toContain("Docker");
  });

  it("wykrywa konfiguracje GitHub Actions i GitLab CI ukryte przed listowaniem", async () => {
    await addFile(".github/workflows/ci.yml", "name: CI\n");
    await addFile(".gitlab-ci.yml", "test:\n  script: echo fixture\n");
    const result = await (await service()).detectProjectTechnologies();
    expect(result.technologies.map((technology) => technology.name)).toEqual(
      expect.arrayContaining(["GitHub Actions", "GitLab CI"]),
    );
  });

  it("nie zgaduje Reacta bez dowodu", async () => {
    const result = await (await service()).detectProjectTechnologies();
    expect(result.technologies.map((technology) => technology.name)).not.toContain("React");
  });
});

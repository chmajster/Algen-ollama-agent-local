import { z } from "zod";

import type {
  ReadFileRangeResult,
  ReadFileResult,
  WorkspaceService,
} from "@local-code-agent/workspace";

import type { ToolRegistry } from "./toolRegistry.js";
import { createToolDefinition } from "./toolTypes.js";

const emptySchema = z.object({}).strict();
const extensionsSchema = z.array(z.string().trim().min(1)).max(100).optional();

const listFilesSchema = z
  .object({
    path: z.string().default("."),
    recursive: z.boolean().default(false),
    maxDepth: z.number().int().min(1).optional(),
    includeDirectories: z.boolean().default(true),
    extensions: extensionsSchema,
  })
  .strict();

const readFileSchema = z
  .object({
    path: z.string().trim().min(1),
    includeLineNumbers: z.boolean().default(true),
  })
  .strict();

const readFileRangeSchema = z
  .object({
    path: z.string().trim().min(1),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    includeLineNumbers: z.boolean().default(true),
  })
  .strict();

const searchTextSchema = z
  .object({
    query: z.string().min(1).max(500),
    path: z.string().default("."),
    useRegex: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
    wholeWord: z.boolean().default(false),
    extensions: extensionsSchema,
    maxResults: z.number().int().min(1).optional(),
    contextLines: z.number().int().min(0).max(10).default(1),
  })
  .strict();

const findFilesSchema = z
  .object({
    name: z.string().min(1).optional(),
    pattern: z.string().min(1).optional(),
    extensions: extensionsSchema,
    path: z.string().default("."),
    maxResults: z.number().int().min(1).optional(),
  })
  .strict();

const repositoryMapSchema = z
  .object({
    path: z.string().default("."),
    maxDepth: z.number().int().min(1).optional(),
    includeFileSizes: z.boolean().default(false),
    includeDetectedLanguages: z.boolean().default(false),
  })
  .strict();

function addLineNumbers(result: ReadFileResult | ReadFileRangeResult): ReadFileResult {
  if (result.binary || result.content === "" || result.startLine === 0) {
    return result;
  }
  const normalized = result.content.replace(/\r\n|\r/gu, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return {
    ...result,
    content: lines.map((line, index) => `${result.startLine + index} | ${line}`).join("\n"),
  };
}

export function registerWorkspaceTools(registry: ToolRegistry, workspace: WorkspaceService): void {
  registry.register({
    name: "get_workspace_info",
    description: "Zwraca bezpieczne informacje o skonfigurowanym workspace i repozytorium Git.",
    schema: emptySchema,
    definition: createToolDefinition(
      "get_workspace_info",
      "Zwraca bezpieczne informacje o skonfigurowanym workspace i repozytorium Git.",
      emptySchema,
    ),
    async execute() {
      return workspace.getWorkspaceInfo();
    },
  });

  registry.register({
    name: "list_files",
    description: "Listuje pliki i katalogi wewnątrz workspace z kontrolą głębokości i rozszerzeń.",
    schema: listFilesSchema,
    definition: createToolDefinition(
      "list_files",
      "Listuje pliki i katalogi wewnątrz workspace z kontrolą głębokości i rozszerzeń.",
      listFilesSchema,
    ),
    async execute({ path, recursive, maxDepth, includeDirectories, extensions }) {
      return workspace.listFiles({
        path,
        recursive,
        includeDirectories,
        ...(maxDepth === undefined ? {} : { maxDepth }),
        ...(extensions === undefined ? {} : { extensions }),
      });
    },
  });

  registry.register({
    name: "read_file",
    description: "Odczytuje bezpieczny plik tekstowy z workspace, z opcjonalnymi numerami linii.",
    schema: readFileSchema,
    definition: createToolDefinition(
      "read_file",
      "Odczytuje bezpieczny plik tekstowy z workspace, z opcjonalnymi numerami linii.",
      readFileSchema,
    ),
    async execute({ path, includeLineNumbers }) {
      const result = await workspace.readFile({ path });
      return includeLineNumbers ? addLineNumbers(result) : result;
    },
  });

  registry.register({
    name: "read_file_range",
    description:
      "Odczytuje wskazany zakres linii pliku tekstowego bez ładowania dużego pliku w całości.",
    schema: readFileRangeSchema,
    definition: createToolDefinition(
      "read_file_range",
      "Odczytuje wskazany zakres linii pliku tekstowego bez ładowania dużego pliku w całości.",
      readFileRangeSchema,
    ),
    async execute({ path, startLine, endLine, includeLineNumbers }) {
      const result = await workspace.readFileRange({ path, startLine, endLine });
      return includeLineNumbers ? addLineNumbers(result) : result;
    },
  });

  registry.register({
    name: "search_text",
    description: "Wyszukuje tekst lub bezpieczne wyrażenie regularne w plikach workspace.",
    schema: searchTextSchema,
    definition: createToolDefinition(
      "search_text",
      "Wyszukuje tekst lub bezpieczne wyrażenie regularne w plikach workspace.",
      searchTextSchema,
    ),
    async execute({
      query,
      path,
      useRegex,
      caseSensitive,
      wholeWord,
      extensions,
      maxResults,
      contextLines,
    }) {
      return workspace.searchText({
        query,
        path,
        useRegex,
        caseSensitive,
        wholeWord,
        contextLines,
        ...(extensions === undefined ? {} : { extensions }),
        ...(maxResults === undefined ? {} : { maxResults }),
      });
    },
  });

  registry.register({
    name: "find_files",
    description: "Odnajduje pliki po nazwie, fragmencie nazwy, prostym globie lub rozszerzeniu.",
    schema: findFilesSchema,
    definition: createToolDefinition(
      "find_files",
      "Odnajduje pliki po nazwie, fragmencie nazwy, prostym globie lub rozszerzeniu.",
      findFilesSchema,
    ),
    async execute({ name, pattern, extensions, path, maxResults }) {
      return workspace.findFiles({
        path,
        ...(name === undefined ? {} : { name }),
        ...(pattern === undefined ? {} : { pattern }),
        ...(extensions === undefined ? {} : { extensions }),
        ...(maxResults === undefined ? {} : { maxResults }),
      });
    },
  });

  registry.register({
    name: "get_repository_map",
    description: "Tworzy zwartą mapę drzewa repozytorium bez odczytywania treści plików.",
    schema: repositoryMapSchema,
    definition: createToolDefinition(
      "get_repository_map",
      "Tworzy zwartą mapę drzewa repozytorium bez odczytywania treści plików.",
      repositoryMapSchema,
    ),
    async execute({ path, maxDepth, includeFileSizes, includeDetectedLanguages }) {
      return workspace.getRepositoryMap({
        path,
        includeFileSizes,
        includeDetectedLanguages,
        ...(maxDepth === undefined ? {} : { maxDepth }),
      });
    },
  });

  registry.register({
    name: "detect_project_technologies",
    description: "Wykrywa technologie projektu wyłącznie na podstawie plików i konfiguracji.",
    schema: emptySchema,
    definition: createToolDefinition(
      "detect_project_technologies",
      "Wykrywa technologie projektu wyłącznie na podstawie plików i konfiguracji.",
      emptySchema,
    ),
    async execute() {
      return workspace.detectProjectTechnologies();
    },
  });

  registry.register({
    name: "get_git_status",
    description: "Zwraca tylko do odczytu status, gałąź i HEAD repozytorium Git.",
    schema: emptySchema,
    definition: createToolDefinition(
      "get_git_status",
      "Zwraca tylko do odczytu status, gałąź i HEAD repozytorium Git.",
      emptySchema,
    ),
    async execute() {
      return workspace.getGitStatus();
    },
  });
}

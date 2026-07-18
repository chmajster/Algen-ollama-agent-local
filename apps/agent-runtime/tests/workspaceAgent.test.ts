import { describe, expect, it } from "vitest";

import type {
  AgentModelClient,
  ModelChatRequest,
  ModelChatResponse,
  ModelToolCall,
} from "@local-code-agent/shared-types";
import { PathOutsideWorkspaceError } from "@local-code-agent/workspace";
import type {
  FindFilesResult,
  GitStatusResult,
  ListFilesResult,
  ProjectTechnologyResult,
  ReadFileRangeResult,
  ReadFileResult,
  RepositoryMapResult,
  SearchTextResult,
  WorkspaceInfo,
  WorkspaceService,
} from "@local-code-agent/workspace";

import { AgentLoop } from "../src/agent/agentLoop.js";
import { ToolRegistry } from "../src/tools/toolRegistry.js";
import { registerWorkspaceTools } from "../src/tools/workspaceTools.js";

function call(name: string, args: unknown): ModelToolCall {
  return { function: { name, arguments: args } };
}

function answer(content: string, toolCalls?: ModelToolCall[]): ModelChatResponse {
  return {
    message: {
      role: "assistant",
      content,
      ...(toolCalls === undefined ? {} : { toolCalls }),
    },
  };
}

class QueueClient implements AgentModelClient {
  public readonly requests: ModelChatRequest[] = [];

  public constructor(private readonly responses: ModelChatResponse[]) {}

  public async checkAvailability(): Promise<void> {}

  public async chat(request: ModelChatRequest): Promise<ModelChatResponse> {
    this.requests.push({
      messages: request.messages.map((message) => ({ ...message })),
      tools: request.tools,
    });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("Brak odpowiedzi mocka");
    return response;
  }
}

class StubWorkspace implements WorkspaceService {
  public failReads = false;
  public largeContent = false;

  public async getWorkspaceInfo(): Promise<WorkspaceInfo> {
    return {
      root: "C:/fixture",
      name: "fixture",
      platform: "windows",
      gitRepository: false,
      caseSensitiveFileSystem: false,
      respectGitignore: true,
      includeHiddenFiles: false,
    };
  }

  public async listFiles(): Promise<ListFilesResult> {
    return { path: ".", entries: [], truncated: false };
  }

  public async readFile(): Promise<ReadFileResult> {
    if (this.failReads) throw new PathOutsideWorkspaceError();
    return {
      path: "src/index.ts",
      binary: false,
      sha256: "a".repeat(64),
      language: "TypeScript",
      sizeBytes: 20,
      totalLines: this.largeContent ? 2_000 : 3,
      startLine: 1,
      endLine: this.largeContent ? 2_000 : 3,
      truncated: false,
      content: this.largeContent ? "x".repeat(20_000) : "a\nb\nc\n",
    };
  }

  public async readFileRange(): Promise<ReadFileRangeResult> {
    return {
      path: "src/auth.ts",
      binary: false,
      sha256: "b".repeat(64),
      sizeBytes: 10,
      totalLines: 10,
      startLine: 4,
      endLine: 5,
      truncated: true,
      content: "four\nfive\n",
    };
  }

  public async searchText(): Promise<SearchTextResult> {
    return {
      query: "UserService",
      matches: [
        { path: "src/a.ts", line: 1, column: 1, match: "UserService", preview: "UserService" },
        { path: "src/b.ts", line: 2, column: 3, match: "UserService", preview: "  UserService" },
      ],
      searchedFiles: 2,
      skippedFiles: 0,
      truncated: false,
    };
  }

  public async findFiles(): Promise<FindFilesResult> {
    return { files: [], truncated: false };
  }

  public async getRepositoryMap(): Promise<RepositoryMapResult> {
    return {
      map: "fixture/\n└── src/\n    └── index.ts",
      directories: 1,
      files: 1,
      languages: { TypeScript: 1 },
      truncated: false,
    };
  }

  public async detectProjectTechnologies(): Promise<ProjectTechnologyResult> {
    return {
      technologies: [{ name: "TypeScript", confidence: "high", evidence: ["tsconfig.json"] }],
    };
  }

  public async getGitStatus(): Promise<GitStatusResult> {
    return { isRepository: false };
  }
}

function createAgent(
  client: AgentModelClient,
  workspace: WorkspaceService,
  maxChars = 50_000,
): AgentLoop {
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, workspace);
  return new AgentLoop(client, registry, {
    defaultMaxSteps: 10,
    maxToolResultChars: maxChars,
  });
}

function lastToolContent(client: QueueClient, requestIndex: number): string {
  return (
    client.requests[requestIndex]?.messages.filter((message) => message.role === "tool").at(-1)
      ?.content ?? ""
  );
}

describe("integracja narzędzi workspace z agentem", () => {
  it("model wywołuje get_repository_map", async () => {
    const client = new QueueClient([
      answer("", [call("get_repository_map", { maxDepth: 4 })]),
      answer("Mapa przeanalizowana"),
    ]);
    const result = await createAgent(client, new StubWorkspace()).run({ task: "Pokaż mapę" });
    expect(result.finishReason).toBe("completed");
    expect(lastToolContent(client, 1)).toContain("index.ts");
  });

  it("model wywołuje read_file", async () => {
    const client = new QueueClient([
      answer("", [call("read_file", { path: "src/index.ts" })]),
      answer("Plik odczytany"),
    ]);
    const result = await createAgent(client, new StubWorkspace()).run({ task: "Czytaj" });
    expect(result.filesRead).toBe(1);
    expect(lastToolContent(client, 1)).toContain("1 | a");
  });

  it("wykonuje kilka różnych narzędzi odczytowych", async () => {
    const client = new QueueClient([
      answer("", [call("get_repository_map", {})]),
      answer("", [call("read_file_range", { path: "src/auth.ts", startLine: 4, endLine: 5 })]),
      answer("Gotowe"),
    ]);
    const result = await createAgent(client, new StubWorkspace()).run({ task: "Analizuj" });
    expect(result).toMatchObject({ steps: 3, toolCalls: 2, filesRead: 1, linesRead: 2 });
  });

  it("zwraca modelowi ustrukturyzowany błąd workspace", async () => {
    const workspace = new StubWorkspace();
    workspace.failReads = true;
    const client = new QueueClient([
      answer("", [call("read_file", { path: "../secret" })]),
      answer("Dostęp zablokowany"),
    ]);
    const result = await createAgent(client, workspace).run({ task: "Czytaj poza workspace" });
    expect(result.toolErrors).toBe(1);
    expect(lastToolContent(client, 1)).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  it("zlicza odczyty, linie, wyszukiwania i dopasowania", async () => {
    const client = new QueueClient([
      answer("", [call("read_file", { path: "src/index.ts" })]),
      answer("", [call("search_text", { query: "UserService" })]),
      answer("Gotowe"),
    ]);
    const result = await createAgent(client, new StubWorkspace()).run({ task: "Zbierz dane" });
    expect(result).toMatchObject({
      filesRead: 1,
      linesRead: 3,
      searchesPerformed: 1,
      searchMatches: 2,
      toolErrors: 0,
      uniqueFilesAccessed: ["src/index.ts"],
    });
  });

  it("ogranicza duży wynik jako poprawny JSON", async () => {
    const workspace = new StubWorkspace();
    workspace.largeContent = true;
    const client = new QueueClient([
      answer("", [call("read_file", { path: "src/index.ts", includeLineNumbers: false })]),
      answer("Wynik skrócony"),
    ]);
    await createAgent(client, workspace, 1_000).run({ task: "Duży plik" });
    const content = lastToolContent(client, 1);
    expect(content.length).toBeLessThanOrEqual(1_000);
    expect(() => JSON.parse(content) as unknown).not.toThrow();
    expect(content).toContain("skrócony przez runtime");
  });
});

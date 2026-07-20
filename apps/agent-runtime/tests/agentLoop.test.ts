import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  AgentMessage,
  AgentModelClient,
  ModelChatRequest,
  ModelChatResponse,
  ModelToolCall,
} from "@local-code-agent/shared-types";

import { AgentLoop } from "../src/agent/agentLoop.js";
import { ToolRegistry } from "../src/tools/toolRegistry.js";
import { createToolDefinition } from "../src/tools/toolTypes.js";

function response(content: string, toolCalls?: ModelToolCall[]): ModelChatResponse {
  return {
    message: {
      role: "assistant",
      content,
      ...(toolCalls === undefined ? {} : { toolCalls }),
    },
  };
}

function call(name: string, argumentsValue: unknown): ModelToolCall {
  return { function: { name, arguments: argumentsValue } };
}

class MockModelClient implements AgentModelClient {
  public readonly requests: ModelChatRequest[] = [];

  public constructor(private readonly responses: ModelChatResponse[]) {}

  public async checkAvailability(): Promise<void> {}

  public async chat(request: ModelChatRequest): Promise<ModelChatResponse> {
    this.requests.push({
      messages: request.messages.map((message) => ({
        ...message,
        ...(message.toolCalls === undefined
          ? {}
          : {
              toolCalls: message.toolCalls.map((toolCall) => ({
                function: { ...toolCall.function },
              })),
            }),
      })),
      tools: request.tools,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error("Brak przygotowanej odpowiedzi mocka.");
    }
    return next;
  }
}

const echoSchema = z.object({ value: z.string() }).strict();

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "Czyta plik.",
    schema: z.object({ path: z.string() }).strict(),
    definition: createToolDefinition(
      "read_file",
      "Czyta plik.",
      z.object({ path: z.string() }).strict(),
    ),
    async execute({ path }): Promise<Record<string, unknown>> {
      return { path, binary: false, startLine: 1, endLine: 1, content: path };
    },
  });
  registry.register({
    name: "echo",
    description: "Zwraca wartość.",
    schema: echoSchema,
    definition: createToolDefinition("echo", "Zwraca wartość.", echoSchema),
    async execute({ value }): Promise<{ value: string }> {
      return { value };
    },
  });
  registry.register({
    name: "fail",
    description: "Zgłasza kontrolowany wyjątek.",
    schema: z.object({}).strict(),
    definition: createToolDefinition(
      "fail",
      "Zgłasza kontrolowany wyjątek.",
      z.object({}).strict(),
    ),
    async execute(): Promise<never> {
      throw new Error("kontrolowana awaria");
    },
  });
  return registry;
}

function createAgent(client: AgentModelClient): AgentLoop {
  return new AgentLoop(client, createRegistry(), { defaultMaxSteps: 20 });
}

function toolMessages(request: ModelChatRequest): AgentMessage[] {
  return request.messages.filter((message) => message.role === "tool");
}

describe("AgentLoop", () => {
  it("blokuje dodatkowe odczyty w tej samej odpowiedzi po osiÄ…gniÄ™ciu limitu plikĂłw", async () => {
    const client = new MockModelClient([
      response("", [call("read_file", { path: "a.ts" }), call("read_file", { path: "b.ts" })]),
      response("Gotowe"),
    ]);
    const agent = new AgentLoop(client, createRegistry(), {
      defaultMaxSteps: 4,
      maxFilesPerTask: 1,
    });

    const result = await agent.run({ task: "Odczytaj pliki" });

    expect(result).toMatchObject({ finishReason: "completed", filesRead: 1, toolErrors: 1 });
    const messages = toolMessages(client.requests[1] ?? { messages: [], tools: [] });
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain("FILE_LIMIT_EXCEEDED");
  });

  it("kończy po odpowiedzi modelu bez narzędzia", async () => {
    const client = new MockModelClient([response("Gotowe")]);

    const result = await createAgent(client).run({ task: "Odpowiedz" });

    expect(result).toMatchObject({
      answer: "Gotowe",
      steps: 1,
      toolCalls: 0,
      finishReason: "completed",
      filesRead: 0,
      toolErrors: 0,
    });
  });

  it("wykonuje jedno narzędzie i przekazuje wynik do modelu", async () => {
    const client = new MockModelClient([
      response("", [call("echo", { value: "raz" })]),
      response("Wynik to raz"),
    ]);

    const result = await createAgent(client).run({ task: "Użyj narzędzia" });

    expect(result.finishReason).toBe("completed");
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(toolMessages(client.requests[1] ?? { messages: [], tools: [] })[0]?.content).toContain(
      '"value":"raz"',
    );
  });

  it("obsługuje kilka kolejnych wywołań narzędzi", async () => {
    const client = new MockModelClient([
      response("", [call("echo", { value: "raz" })]),
      response("", [call("echo", { value: "dwa" })]),
      response("Koniec"),
    ]);

    const result = await createAgent(client).run({ task: "Dwa kroki" });

    expect(result).toMatchObject({ steps: 3, toolCalls: 2, finishReason: "completed" });
    expect(toolMessages(client.requests[2] ?? { messages: [], tools: [] })).toHaveLength(2);
  });

  it("przekazuje modelowi czytelny błąd nieznanego narzędzia", async () => {
    const client = new MockModelClient([
      response("", [call("unknown", {})]),
      response("Nie mam takiego narzędzia"),
    ]);

    const result = await createAgent(client).run({ task: "Nieznane narzędzie" });

    expect(result.finishReason).toBe("completed");
    expect(toolMessages(client.requests[1] ?? { messages: [], tools: [] })[0]?.content).toContain(
      "UnknownToolError",
    );
  });

  it("przekazuje modelowi błąd walidacji argumentów", async () => {
    const client = new MockModelClient([
      response("", [call("echo", { value: 123 })]),
      response("Argument był niepoprawny"),
    ]);

    await createAgent(client).run({ task: "Złe argumenty" });

    expect(toolMessages(client.requests[1] ?? { messages: [], tools: [] })[0]?.content).toContain(
      "ToolValidationError",
    );
  });

  it("przekazuje modelowi błąd wykonania narzędzia", async () => {
    const client = new MockModelClient([
      response("", [call("fail", {})]),
      response("Narzędzie uległo awarii"),
    ]);

    await createAgent(client).run({ task: "Awaria" });

    const message = toolMessages(client.requests[1] ?? { messages: [], tools: [] })[0]?.content;
    expect(message).toContain("ToolExecutionError");
    expect(message).toContain("kontrolowana awaria");
  });

  it("kończy kontrolowanie po przekroczeniu limitu kroków", async () => {
    const client = new MockModelClient([
      response("", [call("echo", { value: "raz" })]),
      response("", [call("echo", { value: "dwa" })]),
    ]);

    const result = await createAgent(client).run({ task: "Zapętl się", maxSteps: 2 });

    expect(result).toMatchObject({ steps: 2, toolCalls: 2, finishReason: "max_steps" });
    expect(result.answer).toContain("limit 2 kroków");
  });

  it("wykrywa identyczne powtarzające się wywołanie", async () => {
    const repeated = call("echo", { value: "to samo" });
    const client = new MockModelClient([response("", [repeated]), response("", [repeated])]);

    const result = await createAgent(client).run({ task: "Powtarzaj" });

    expect(result.finishReason).toBe("error");
    expect(result.answer).toContain("powtarzające się");
    expect(result.steps).toBe(2);
  });

  it("przerywa bez zapytania modelu po anulowaniu sygnału", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new MockModelClient([]);

    const result = await createAgent(client).run({ task: "Przerwij", signal: controller.signal });

    expect(result).toMatchObject({ steps: 0, toolCalls: 0, finishReason: "aborted" });
    expect(client.requests).toHaveLength(0);
  });
});

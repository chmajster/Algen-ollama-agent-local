import { Ollama } from "ollama";
import type { Message, Tool, ToolCall } from "ollama";

import type {
  AgentMessage,
  AgentModelClient,
  ModelChatRequest,
  ModelChatResponse,
  ModelToolCall,
  OllamaToolDefinition,
} from "@local-code-agent/shared-types";

import type { AgentConfig } from "./config.js";
import { ModelNotFoundError, OllamaConnectionError, OllamaRequestError } from "./errors.js";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isModelNotFound(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status_code" in error) {
    return error.status_code === 404;
  }

  return error instanceof Error && /model.+(not found|does not exist)/iu.test(error.message);
}

function errorDetails(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combineSignals(
  external: AbortSignal,
  internal: AbortSignal | null | undefined,
): AbortSignal {
  return internal === undefined || internal === null
    ? external
    : AbortSignal.any([external, internal]);
}

function createAbortableFetch(signal?: AbortSignal): typeof fetch | undefined {
  if (signal === undefined) {
    return undefined;
  }

  return (input, init) =>
    fetch(input, {
      ...init,
      signal: combineSignals(signal, init?.signal),
    });
}

function toOllamaMessage(message: AgentMessage): Message {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls === undefined
      ? {}
      : { tool_calls: message.toolCalls.map(toOllamaToolCall) }),
    ...(message.toolName === undefined ? {} : { tool_name: message.toolName }),
  };
}

function toArgumentRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toOllamaToolCall(call: ModelToolCall): ToolCall {
  return {
    function: {
      name: call.function.name,
      arguments: toArgumentRecord(call.function.arguments),
    },
  };
}

function normalizeToolArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function toModelToolCall(
  call: Message["tool_calls"] extends Array<infer T> | undefined ? T : never,
): ModelToolCall {
  return {
    function: {
      name: call.function.name,
      arguments: normalizeToolArguments(call.function.arguments),
    },
  };
}

function fromOllamaMessage(message: Message): AgentMessage {
  const toolCalls = message.tool_calls?.map(toModelToolCall);
  return {
    role: "assistant",
    content: message.content,
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(message.tool_name === undefined ? {} : { toolName: message.tool_name }),
  };
}

function toOllamaTool(definition: OllamaToolDefinition): Tool {
  return {
    type: definition.type,
    function: {
      name: definition.function.name,
      description: definition.function.description,
      parameters: definition.function.parameters as NonNullable<Tool["function"]["parameters"]>,
    },
  };
}

export class OllamaClient implements AgentModelClient {
  private static modelQueue: Promise<void> = Promise.resolve();
  private static activeModel: string | undefined;

  public constructor(private readonly config: AgentConfig) {}

  private async withModelSlot<T>(operation: () => Promise<T>): Promise<T> {
    const previous = OllamaClient.modelQueue;
    let release!: () => void;
    OllamaClient.modelQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (
        this.config.maxLoadedModels === 1 &&
        OllamaClient.activeModel !== undefined &&
        OllamaClient.activeModel !== this.config.ollamaModel
      ) {
        await this.createClient().generate({
          model: OllamaClient.activeModel,
          prompt: "",
          stream: false,
          keep_alive: 0,
        });
      }
      OllamaClient.activeModel = this.config.ollamaModel;
      return await operation();
    } finally {
      release();
    }
  }

  private createClient(signal?: AbortSignal): Ollama {
    const abortableFetch = createAbortableFetch(signal);
    return new Ollama({
      host: this.config.ollamaHost,
      ...(abortableFetch === undefined ? {} : { fetch: abortableFetch }),
    });
  }

  public async checkAvailability(signal?: AbortSignal): Promise<void> {
    try {
      const response = await this.createClient(signal).list();
      const available = response.models.some(
        (model) =>
          model.name === this.config.ollamaModel || model.model === this.config.ollamaModel,
      );

      if (!available) {
        throw new ModelNotFoundError(this.config.ollamaModel);
      }
    } catch (error: unknown) {
      if (isAbortError(error) || error instanceof ModelNotFoundError) {
        throw error;
      }
      throw new OllamaConnectionError(this.config.ollamaHost, { cause: error });
    }
  }

  public async chat(request: ModelChatRequest): Promise<ModelChatResponse> {
    try {
      const response = await this.withModelSlot(() =>
        this.createClient(request.signal).chat({
          model: this.config.ollamaModel,
          messages: request.messages.map(toOllamaMessage),
          tools: request.tools.map(toOllamaTool),
          stream: false,
          think: false,
          keep_alive: this.config.ollamaKeepAlive,
          options: {
            temperature: this.config.temperature,
            num_ctx: this.config.contextLength,
            num_predict: this.config.ollamaMaxResponseTokens,
          },
        }),
      );

      return { message: fromOllamaMessage(response.message) };
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }
      if (isModelNotFound(error)) {
        throw new ModelNotFoundError(this.config.ollamaModel, { cause: error });
      }
      if (error instanceof TypeError || /fetch|connect|ECONNREFUSED/iu.test(errorDetails(error))) {
        throw new OllamaConnectionError(this.config.ollamaHost, { cause: error });
      }
      throw new OllamaRequestError(errorDetails(error), { cause: error });
    }
  }
}

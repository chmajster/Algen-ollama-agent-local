import type { ZodError } from "zod";

import type { OllamaToolDefinition } from "@local-code-agent/shared-types";

import { ToolExecutionError, ToolValidationError, UnknownToolError } from "../errors.js";
import type { AgentTool } from "./toolTypes.js";

interface RegisteredTool {
  definition: OllamaToolDefinition;
  execute(rawArguments: unknown): Promise<unknown>;
}

function validationDetails(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "argumenty"}: ${issue.message}`)
    .join("; ");
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  public register<TArgs, TResult>(tool: AgentTool<TArgs, TResult>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Narzędzie o nazwie ${tool.name} jest już zarejestrowane.`);
    }

    if (tool.definition.function.name !== tool.name) {
      throw new Error(`Definicja narzędzia ${tool.name} zawiera inną nazwę funkcji.`);
    }

    this.tools.set(tool.name, {
      definition: tool.definition,
      execute: async (rawArguments: unknown): Promise<unknown> => {
        const parsed = tool.schema.safeParse(rawArguments);
        if (!parsed.success) {
          throw new ToolValidationError(tool.name, validationDetails(parsed.error), {
            cause: parsed.error,
          });
        }

        try {
          return await tool.execute(parsed.data);
        } catch (error: unknown) {
          if (error instanceof ToolExecutionError) {
            throw error;
          }
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string" &&
            "recoverable" in error &&
            typeof error.recoverable === "boolean"
          ) {
            throw error;
          }
          const details = error instanceof Error ? error.message : String(error);
          throw new ToolExecutionError(tool.name, details, { cause: error });
        }
      },
    });
  }

  public getDefinitions(): OllamaToolDefinition[] {
    return [...this.tools.values()].map(({ definition }) => definition);
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public async execute(name: string, rawArguments: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new UnknownToolError(name);
    }
    return tool.execute(rawArguments);
  }
}

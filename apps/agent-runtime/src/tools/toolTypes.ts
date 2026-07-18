import { z } from "zod";
import type { ZodType } from "zod";

import type { OllamaToolDefinition } from "@local-code-agent/shared-types";

export interface AgentTool<TArgs, TResult> {
  name: string;
  description: string;
  schema: ZodType<TArgs>;
  definition: OllamaToolDefinition;
  execute(args: TArgs): Promise<TResult>;
}

export function createToolDefinition<TArgs>(
  name: string,
  description: string,
  schema: ZodType<TArgs>,
): OllamaToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: z.toJSONSchema(schema) as Record<string, unknown>,
    },
  };
}

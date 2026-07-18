import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ToolExecutionError, ToolValidationError, UnknownToolError } from "../src/errors.js";
import { getCurrentTimeTool } from "../src/tools/getCurrentTime.js";
import { ToolRegistry } from "../src/tools/toolRegistry.js";
import { createToolDefinition } from "../src/tools/toolTypes.js";
import type { AgentTool } from "../src/tools/toolTypes.js";

const greetingSchema = z.object({ name: z.string().min(1) }).strict();
const greetingTool: AgentTool<z.infer<typeof greetingSchema>, { greeting: string }> = {
  name: "greet",
  description: "Wita użytkownika.",
  schema: greetingSchema,
  definition: createToolDefinition("greet", "Wita użytkownika.", greetingSchema),
  async execute({ name }): Promise<{ greeting: string }> {
    return { greeting: `Cześć, ${name}!` };
  },
};

describe("ToolRegistry", () => {
  it("rejestruje narzędzie i udostępnia definicję dla Ollamy", () => {
    const registry = new ToolRegistry();
    registry.register(greetingTool);

    expect(registry.has("greet")).toBe(true);
    expect(registry.getDefinitions()).toHaveLength(1);
    expect(registry.getDefinitions()[0]?.function.name).toBe("greet");
    expect(registry.getDefinitions()[0]?.function.parameters).toMatchObject({ type: "object" });
  });

  it("waliduje argumenty przez Zod", async () => {
    const registry = new ToolRegistry();
    registry.register(greetingTool);

    await expect(registry.execute("greet", { name: 42 })).rejects.toBeInstanceOf(
      ToolValidationError,
    );
  });

  it("wykonuje poprawne narzędzie", async () => {
    const registry = new ToolRegistry();
    registry.register(greetingTool);

    await expect(registry.execute("greet", { name: "Ada" })).resolves.toEqual({
      greeting: "Cześć, Ada!",
    });
  });

  it("wykonuje rzeczywiste narzędzie czasu bez argumentów", async () => {
    const registry = new ToolRegistry();
    registry.register(getCurrentTimeTool);

    await expect(registry.execute("get_current_time", {})).resolves.toMatchObject({
      isoTime: expect.any(String),
      timezoneOffset: expect.stringMatching(/^[+-]\d{2}:\d{2}$/u),
    });
  });

  it("zgłasza nieznane narzędzie", async () => {
    const registry = new ToolRegistry();
    await expect(registry.execute("missing", {})).rejects.toBeInstanceOf(UnknownToolError);
  });

  it("opakowuje wyjątek wykonania w błąd domenowy", async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...greetingTool,
      name: "broken",
      definition: createToolDefinition("broken", "Zgłasza błąd.", greetingSchema),
      async execute(): Promise<{ greeting: string }> {
        throw new Error("awaria");
      },
    });

    await expect(registry.execute("broken", { name: "Ada" })).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });
});

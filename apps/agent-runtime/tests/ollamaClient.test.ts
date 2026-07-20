import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { OllamaClient } from "../src/ollamaClient.js";

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
}));

vi.mock("ollama", () => ({
  Ollama: class {
    public chat(request: unknown): unknown {
      return mocks.chat(request);
    }
  },
}));

describe("OllamaClient", () => {
  beforeEach(() => {
    mocks.chat.mockReset();
    mocks.chat.mockResolvedValue({ message: { role: "assistant", content: "OK" } });
  });

  it("lets Ollama select a safe batch size for prompts", async () => {
    const config = await loadConfig({
      overrides: { workspace: process.cwd(), ollamaModel: "test-model:1b" },
    });
    const client = new OllamaClient(config);

    await client.chat({
      messages: [{ role: "user", content: "A prompt containing more than one token" }],
      tools: [],
    });

    expect(mocks.chat).toHaveBeenCalledOnce();
    expect(mocks.chat.mock.calls[0]?.[0]).toMatchObject({
      model: "test-model:1b",
      options: {
        num_ctx: config.contextLength,
        num_predict: config.ollamaMaxResponseTokens,
      },
    });
    expect(mocks.chat.mock.calls[0]?.[0].options).not.toHaveProperty("num_batch");
  });
});

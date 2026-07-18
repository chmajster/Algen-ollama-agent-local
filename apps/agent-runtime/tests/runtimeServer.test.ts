import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createRequest, type ProcedureName } from "@local-code-agent/runtime-protocol";

import { RuntimeServer } from "../src/server/runtimeServer.js";

const sessionId = "runtime-server-tests";

async function exchange(
  requests: Array<{ method: ProcedureName; payload: Record<string, unknown>; session?: string }>,
): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    text += chunk;
  });
  const server = new RuntimeServer({ input, output, sessionId, now: () => 1_000 });
  const running = server.start();
  for (const [index, request] of requests.entries()) {
    input.write(
      `${JSON.stringify(createRequest(index + 1, request.method, request.session ?? sessionId, request.payload as never))}\n`,
    );
  }
  input.end();
  await running;
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function response(messages: Array<Record<string, unknown>>, id: number): Record<string, unknown> {
  const found = messages.find((message) => message.id === id);
  if (found === undefined) throw new Error(`Brak odpowiedzi ${id}.`);
  return found;
}

function payload(message: Record<string, unknown>): Record<string, unknown> {
  const result = message.result as { payload: Record<string, unknown> };
  return result.payload;
}

describe("RuntimeServer", () => {
  it("announces readiness before handling requests", async () => {
    const messages = await exchange([{ method: "runtime.health", payload: {} }]);
    expect(messages[0]?.method).toBe("runtime.ready");
  });

  it("initializes the protocol session", async () => {
    const messages = await exchange([
      {
        method: "runtime.initialize",
        payload: { clientName: "tests", clientVersion: "1.0.0", workspaceTrusted: true },
      },
    ]);
    expect(payload(response(messages, 1))).toMatchObject({
      runtimeName: "Local Code Agent Runtime",
      protocolVersion: "1.2.0",
    });
  });

  it("reports health without contacting Ollama", async () => {
    const messages = await exchange([{ method: "runtime.health", payload: {} }]);
    expect(payload(response(messages, 1))).toEqual({ status: "ok", uptimeMs: 0 });
  });

  it("reports all capabilities", async () => {
    const messages = await exchange([{ method: "runtime.getCapabilities", payload: {} }]);
    expect(payload(response(messages, 1)).capabilities).toContain("changes.apply");
  });

  it("sets and returns a single-root workspace", async () => {
    const root = process.cwd();
    const info = { activeRoot: root, roots: [root], trusted: true, kind: "single-root" };
    const messages = await exchange([
      { method: "workspace.set", payload: info },
      { method: "workspace.getInfo", payload: {} },
    ]);
    expect(payload(response(messages, 2))).toEqual(info);
  });

  it("updates safe runtime settings", async () => {
    const messages = await exchange([
      { method: "settings.update", payload: { maxSteps: 7, mode: "plan" } },
      { method: "settings.get", payload: {} },
    ]);
    expect(payload(response(messages, 2))).toMatchObject({ maxSteps: 7, mode: "plan" });
  });

  it("starts with conservative settings", async () => {
    const messages = await exchange([{ method: "settings.get", payload: {} }]);
    expect(payload(response(messages, 1))).toMatchObject({
      allowNetwork: false,
      allowPackageInstall: false,
      allowFileDelete: false,
      autoStartRuntime: false,
    });
  });

  it("keeps task history empty before the first task", async () => {
    const messages = await exchange([{ method: "task.list", payload: {} }]);
    expect(payload(response(messages, 1))).toEqual({ tasks: [] });
  });

  it("blocks tasks when no workspace is selected", async () => {
    const messages = await exchange([
      { method: "task.start", payload: { task: "Test", mode: "edit" } },
    ]);
    expect(response(messages, 1).error).toMatchObject({ code: -32_002 });
  });

  it("blocks untrusted Ask without an explicit selection", async () => {
    const messages = await exchange([
      {
        method: "runtime.initialize",
        payload: { clientName: "tests", clientVersion: "1.0.0", workspaceTrusted: false },
      },
      { method: "task.start", payload: { task: "Test", mode: "ask" } },
    ]);
    expect(response(messages, 2).error).toMatchObject({ code: -32_002 });
  });

  it("rejects messages from a foreign session", async () => {
    const messages = await exchange([
      { method: "runtime.health", payload: {}, session: "foreign-session" },
    ]);
    expect(response(messages, 1).error).toMatchObject({ code: -32_600 });
  });

  it("shuts down cleanly", async () => {
    const messages = await exchange([{ method: "runtime.shutdown", payload: {} }]);
    expect(payload(response(messages, 1))).toEqual({ ok: true });
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileHashService,
  LocalChangeService,
  type AccessMode,
} from "@local-code-agent/change-engine";
import type {
  AgentModelClient,
  ModelChatRequest,
  ModelChatResponse,
  ModelToolCall,
} from "@local-code-agent/shared-types";

import { AgentLoop } from "../src/agent/agentLoop.js";
import { registerChangeTools } from "../src/tools/changeTools.js";
import { ToolRegistry } from "../src/tools/toolRegistry.js";

function call(name: string, args: unknown): ModelToolCall {
  return { function: { name, arguments: args } };
}

function response(content: string, toolCalls?: ModelToolCall[]): ModelChatResponse {
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
    this.requests.push(request);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("Brak odpowiedzi modelu.");
    return next;
  }
}

describe("narzędzia zmian i AgentLoop", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "change-tools-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function service(mode: AccessMode, decision: "approved" | "pending" = "approved") {
    return LocalChangeService.create({
      workspaceRoot: root,
      mode,
      requireWriteConfirmation: true,
      allowFileDelete: false,
      allowFileMove: true,
      allowSensitiveFileWrite: false,
      allowSymlinkWrite: false,
      defaultEol: "lf",
      checkpointRetention: 20,
      checkpointMaxTotalBytes: 1_000_000,
      limits: {
        maxChangedFiles: 30,
        maxCreatedFileBytes: 100_000,
        maxTotalWriteBytes: 1_000_000,
        maxPatchReplacements: 50,
        maxChangeOperations: 100,
        maxDiffChars: 100_000,
      },
      sessionId: "agent-test",
      confirmationProvider: async () => decision,
    });
  }

  function registry(changes: LocalChangeService): ToolRegistry {
    const result = new ToolRegistry();
    registerChangeTools(result, changes, { allowFileDelete: false, allowFileMove: true });
    return result;
  }

  it("w readonly udostępnia tylko odczytową listę checkpointów", async () => {
    const tools = registry(await service("readonly"));
    expect(tools.has("list_checkpoints")).toBe(true);
    expect(tools.has("prepare_patch")).toBe(false);
    expect(tools.has("apply_changes")).toBe(false);
  });

  it("w preview udostępnia edycję i diff, ale nie apply", async () => {
    const tools = registry(await service("preview"));
    expect(tools.has("prepare_patch")).toBe(true);
    expect(tools.has("preview_changes")).toBe(true);
    expect(tools.has("apply_changes")).toBe(false);
    expect(tools.has("delete_file")).toBe(false);
  });

  it("w write udostępnia apply i restore", async () => {
    const tools = registry(await service("write"));
    expect(tools.has("apply_changes")).toBe(true);
    expect(tools.has("restore_checkpoint")).toBe(true);
    expect(tools.has("move_file")).toBe(true);
  });

  it("prepare_patch i preview nie zapisują pliku", async () => {
    const changes = await service("preview");
    const tools = registry(changes);
    const expectedHash = await new FileHashService().hashFile(join(root, "src", "a.ts"));
    await tools.execute("prepare_patch", {
      path: "src/a.ts",
      expectedHash,
      replacements: [{ oldText: "a = 1", newText: "a = 2" }],
      reason: "zmiana wartości",
    });
    const preview = await tools.execute("preview_changes", {});
    expect(preview).toMatchObject({ canApply: true });
    await expect(readFile(join(root, "src", "a.ts"), "utf8")).resolves.toContain("a = 1");
  });

  it("AgentLoop ustala preview_completed na podstawie runtime", async () => {
    const changes = await service("preview");
    const expectedHash = await new FileHashService().hashFile(join(root, "src", "a.ts"));
    const client = new QueueClient([
      response("", [
        call("prepare_patch", {
          path: "src/a.ts",
          expectedHash,
          replacements: [{ oldText: "a = 1", newText: "a = 2" }],
          reason: "zmiana wartości",
        }),
      ]),
      response("", [call("preview_changes", {})]),
      response("Podgląd gotowy."),
    ]);
    const result = await new AgentLoop(client, registry(changes), {
      defaultMaxSteps: 10,
      changeSession: () => changes.getSessionSnapshot(),
    }).run({ task: "Zmień wartość" });
    expect(result).toMatchObject({
      finishReason: "preview_completed",
      phase: "preview",
      changeSummary: { filesChanged: 1, mode: "preview" },
      writeStatistics: { patchesPrepared: 1, patchesApplied: 0 },
    });
  });

  it("AgentLoop zwraca changes_pending_confirmation bez zapisu", async () => {
    const changes = await service("write", "pending");
    const client = new QueueClient([
      response("", [
        call("create_file", { path: "new.ts", content: "new\n", reason: "nowy plik" }),
      ]),
      response("", [call("preview_changes", {})]),
      response("", [call("apply_changes", { description: "zastosuj" })]),
      response("Zmiany oczekują na zgodę."),
    ]);
    const result = await new AgentLoop(client, registry(changes), {
      defaultMaxSteps: 10,
      changeSession: () => changes.getSessionSnapshot(),
    }).run({ task: "Dodaj plik" });
    expect(result.finishReason).toBe("changes_pending_confirmation");
    await expect(readFile(join(root, "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("AgentLoop zwraca changes_applied i checkpoint po zgodzie", async () => {
    const changes = await service("write", "approved");
    const client = new QueueClient([
      response("", [
        call("create_file", { path: "new.ts", content: "new\n", reason: "nowy plik" }),
      ]),
      response("", [call("preview_changes", {})]),
      response("", [call("apply_changes", {})]),
      response("Zastosowano."),
    ]);
    const result = await new AgentLoop(client, registry(changes), {
      defaultMaxSteps: 10,
      changeSession: () => changes.getSessionSnapshot(),
    }).run({ task: "Dodaj plik" });
    expect(result.finishReason).toBe("changes_applied");
    expect(result.changeSummary?.checkpointId).toBeDefined();
    await expect(readFile(join(root, "new.ts"), "utf8")).resolves.toBe("new\n");
  });

  it("po rzeczywistej zmianie pozwala ponownie wywołać apply_changes dla poprawki", async () => {
    const changes = await service("write", "approved");
    const expectedHash = new FileHashService().hashBytes(Buffer.from("bad\n"));
    const client = new QueueClient([
      response("", [
        call("create_file", { path: "repair.ts", content: "bad\n", reason: "pierwsza wersja" }),
      ]),
      response("", [call("preview_changes", {})]),
      response("", [call("apply_changes", {})]),
      response("", [
        call("prepare_patch", {
          path: "repair.ts",
          expectedHash,
          replacements: [{ oldText: "bad", newText: "good" }],
          reason: "poprawka po weryfikacji",
        }),
      ]),
      response("", [call("preview_changes", {})]),
      response("", [call("apply_changes", {})]),
      response("Poprawka zastosowana."),
    ]);

    const result = await new AgentLoop(client, registry(changes), {
      defaultMaxSteps: 10,
      changeSession: () => changes.getSessionSnapshot(),
    }).run({ task: "Zastosuj i popraw" });

    expect(result.finishReason).toBe("changes_applied");
    expect(result.toolCalls).toBe(6);
    await expect(readFile(join(root, "repair.ts"), "utf8")).resolves.toBe("good\n");
  });

  it("przekazuje stabilny konflikt hasha modelowi razem ze ścieżką", async () => {
    const changes = await service("preview");
    const client = new QueueClient([
      response("", [
        call("prepare_patch", {
          path: "src/a.ts",
          expectedHash: "0".repeat(64),
          replacements: [{ oldText: "a = 1", newText: "a = 2" }],
          reason: "zmiana wartości",
        }),
      ]),
      response("Wykryto konflikt."),
    ]);
    await new AgentLoop(client, registry(changes), { defaultMaxSteps: 5 }).run({ task: "Zmień" });
    const toolMessage = client.requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain('"code":"FILE_CHANGED_SINCE_READ"');
    expect(toolMessage?.content).toContain('"path":"src/a.ts"');
  });
});

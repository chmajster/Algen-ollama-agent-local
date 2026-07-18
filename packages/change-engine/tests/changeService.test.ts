import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ChangeSetAlreadyAppliedError,
  ChangeSetConflictError,
  FileChangedSinceReadError,
  FileDeleteDisabledError,
  FileHashService,
  FileMoveDisabledError,
  LocalChangeService,
  TransactionFailedError,
  WriteLimitExceededError,
  WriteModeDisabledError,
  type AccessMode,
  type ChangeServiceOptions,
  type ConfirmationDecision,
} from "../src/index.js";

describe("LocalChangeService", () => {
  let root: string;
  const hashes = new FileHashService();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "change-service-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function options(
    mode: AccessMode,
    decision: ConfirmationDecision = "approved",
    overrides: Partial<ChangeServiceOptions> = {},
  ): ChangeServiceOptions {
    return {
      workspaceRoot: root,
      mode,
      requireWriteConfirmation: true,
      allowFileDelete: true,
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
      sessionId: "test-session",
      confirmationProvider: async () => decision,
      ...overrides,
    };
  }

  async function hash(relativePath: string): Promise<string> {
    return hashes.hashFile(join(root, ...relativePath.split("/")));
  }

  it("tryb readonly blokuje przygotowanie zmian", async () => {
    const service = await LocalChangeService.create(options("readonly"));
    await expect(
      service.prepareCreateFile({ path: "src/new.ts", content: "new\n", reason: "test" }),
    ).rejects.toBeInstanceOf(WriteModeDisabledError);
  });

  it("tryb preview przygotowuje patch i diff bez zapisu", async () => {
    const service = await LocalChangeService.create(options("preview"));
    const prepared = await service.preparePatch({
      path: "src/a.ts",
      expectedHash: await hash("src/a.ts"),
      replacements: [{ oldText: "a = 1", newText: "a = 2" }],
      reason: "aktualizacja wartości",
    });
    expect(prepared.diff).toContain("+export const a = 2;");
    const preview = await service.previewChangeSet();
    expect(preview).toMatchObject({ canApply: true, totals: { filesChanged: 1 } });
    await expect(readFile(join(root, "src", "a.ts"), "utf8")).resolves.toBe(
      "export const a = 1;\n",
    );
    expect(service.getSessionSnapshot()).toMatchObject({
      mode: "preview",
      status: "previewed",
      previewAvailable: true,
    });
  });

  it("tworzy nowy plik i katalog nadrzędny w trybie write", async () => {
    const service = await LocalChangeService.create(options("write"));
    await service.prepareCreateFile({
      path: "generated/nested/new.ts",
      content: "export {};\n",
      reason: "nowy moduł",
    });
    const result = await service.applyChangeSet();
    expect(result.status).toBe("applied");
    expect(result.checkpointId).toBeDefined();
    await expect(readFile(join(root, "generated", "nested", "new.ts"), "utf8")).resolves.toBe(
      "export {};\n",
    );
  });

  it("odrzuca utworzenie istniejącego pliku", async () => {
    const service = await LocalChangeService.create(options("preview"));
    await expect(
      service.prepareCreateFile({ path: "src/a.ts", content: "x", reason: "test" }),
    ).rejects.toMatchObject({ code: "FILE_ALREADY_EXISTS" });
  });

  it("egzekwuje limit rozmiaru nowego pliku", async () => {
    const base = options("preview");
    const service = await LocalChangeService.create({
      ...base,
      limits: { ...base.limits, maxCreatedFileBytes: 3 },
    });
    await expect(
      service.prepareCreateFile({ path: "new.ts", content: "1234", reason: "test" }),
    ).rejects.toBeInstanceOf(WriteLimitExceededError);
  });

  it("blokuje apply poza trybem write", async () => {
    const service = await LocalChangeService.create(options("preview"));
    await service.prepareCreateFile({ path: "new.ts", content: "new\n", reason: "test" });
    await expect(service.applyChangeSet()).rejects.toBeInstanceOf(WriteModeDisabledError);
  });

  it("zwraca pending_confirmation i nie zapisuje bez potwierdzenia", async () => {
    const service = await LocalChangeService.create(options("write", "pending"));
    await service.prepareCreateFile({ path: "new.ts", content: "new\n", reason: "test" });
    await expect(service.applyChangeSet()).resolves.toMatchObject({
      status: "pending_confirmation",
    });
    await expect(stat(join(root, "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("zwraca rejected i nie zapisuje po odmowie", async () => {
    const service = await LocalChangeService.create(options("write", "rejected"));
    await service.prepareCreateFile({ path: "new.ts", content: "new\n", reason: "test" });
    await expect(service.applyChangeSet()).resolves.toMatchObject({ status: "rejected" });
    await expect(stat(join(root, "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("usuwa plik z poprawnym hashem i zachowuje go w checkpoincie", async () => {
    const service = await LocalChangeService.create(options("write"));
    await service.prepareDeleteFile({
      path: "src/a.ts",
      expectedHash: await hash("src/a.ts"),
      reason: "plik zbędny",
    });
    const result = await service.applyChangeSet();
    await expect(stat(join(root, "src", "a.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await service.listCheckpoints()).some((checkpoint) => checkpoint.id === result.checkpointId),
    ).toBe(true);
  });

  it("blokuje usuwanie wyłączone konfiguracją", async () => {
    const service = await LocalChangeService.create(
      options("preview", "approved", { allowFileDelete: false }),
    );
    await expect(
      service.prepareDeleteFile({
        path: "src/a.ts",
        expectedHash: await hash("src/a.ts"),
        reason: "test",
      }),
    ).rejects.toBeInstanceOf(FileDeleteDisabledError);
  });

  it("blokuje usunięcie pliku z błędnym hashem oraz usunięcie katalogu", async () => {
    const service = await LocalChangeService.create(options("preview"));
    await expect(
      service.prepareDeleteFile({
        path: "src/a.ts",
        expectedHash: "0".repeat(64),
        reason: "błędny hash",
      }),
    ).rejects.toBeInstanceOf(FileChangedSinceReadError);
    await expect(
      service.prepareDeleteFile({
        path: "src",
        expectedHash: "0".repeat(64),
        reason: "katalog",
      }),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND_FOR_WRITE" });
  });

  it("przenosi plik bez zmiany treści", async () => {
    const service = await LocalChangeService.create(options("write"));
    await service.prepareMoveFile({
      sourcePath: "src/a.ts",
      destinationPath: "lib/a.ts",
      expectedSourceHash: await hash("src/a.ts"),
      reason: "porządkowanie modułów",
    });
    const preview = await service.previewChangeSet();
    expect(preview.diff).toContain("similarity index 100%");
    await service.applyChangeSet();
    await expect(readFile(join(root, "lib", "a.ts"), "utf8")).resolves.toBe(
      "export const a = 1;\n",
    );
    await expect(stat(join(root, "src", "a.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blokuje przenoszenie wyłączone konfiguracją", async () => {
    const service = await LocalChangeService.create(
      options("preview", "approved", { allowFileMove: false }),
    );
    await expect(
      service.prepareMoveFile({
        sourcePath: "src/a.ts",
        destinationPath: "lib/a.ts",
        expectedSourceHash: await hash("src/a.ts"),
        reason: "test",
      }),
    ).rejects.toBeInstanceOf(FileMoveDisabledError);
  });

  it("blokuje istniejący cel, błędny hash i cel poza workspace przy przenoszeniu", async () => {
    const service = await LocalChangeService.create(options("preview"));
    await expect(
      service.prepareMoveFile({
        sourcePath: "src/a.ts",
        destinationPath: "src/b.ts",
        expectedSourceHash: await hash("src/a.ts"),
        reason: "istniejący cel",
      }),
    ).rejects.toMatchObject({ code: "FILE_ALREADY_EXISTS" });
    await expect(
      service.prepareMoveFile({
        sourcePath: "src/a.ts",
        destinationPath: "lib/a.ts",
        expectedSourceHash: "0".repeat(64),
        reason: "błędny hash",
      }),
    ).rejects.toBeInstanceOf(FileChangedSinceReadError);
    await expect(
      service.prepareMoveFile({
        sourcePath: "src/a.ts",
        destinationPath: "../outside.ts",
        expectedSourceHash: await hash("src/a.ts"),
        reason: "poza workspace",
      }),
    ).rejects.toMatchObject({ code: "INVALID_FILE_NAME" });
  });

  it("wykrywa zewnętrzną zmianę od czasu odczytu", async () => {
    const service = await LocalChangeService.create(options("write"));
    await service.preparePatch({
      path: "src/a.ts",
      expectedHash: await hash("src/a.ts"),
      replacements: [{ oldText: "a = 1", newText: "a = 2" }],
      reason: "test",
    });
    await writeFile(join(root, "src", "a.ts"), "external\n");
    const preview = await service.previewChangeSet();
    expect(preview.conflicts[0]).toMatchObject({ code: "FILE_CHANGED_SINCE_READ" });
    await expect(service.applyChangeSet()).rejects.toBeInstanceOf(FileChangedSinceReadError);
    await expect(readFile(join(root, "src", "a.ts"), "utf8")).resolves.toBe("external\n");
  });

  it("wykrywa dwie operacje na tej samej ścieżce", async () => {
    const service = await LocalChangeService.create(options("preview"));
    await service.preparePatch({
      path: "src/a.ts",
      expectedHash: await hash("src/a.ts"),
      replacements: [{ oldText: "a = 1", newText: "a = 2" }],
      reason: "pierwsza",
    });
    await expect(
      service.prepareDeleteFile({
        path: "src/a.ts",
        expectedHash: await hash("src/a.ts"),
        reason: "druga",
      }),
    ).rejects.toBeInstanceOf(ChangeSetConflictError);
  });

  it("wycofuje całość po błędzie drugiej operacji", async () => {
    const service = await LocalChangeService.create(
      options("write", "approved", {
        transactionHook: async (index) => {
          if (index === 1) throw new Error("injected");
        },
      }),
    );
    await service.prepareCreateFile({ path: "one.ts", content: "one\n", reason: "pierwszy" });
    await service.prepareCreateFile({ path: "two.ts", content: "two\n", reason: "drugi" });
    await expect(service.applyChangeSet()).rejects.toBeInstanceOf(TransactionFailedError);
    await expect(stat(join(root, "one.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "two.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(service.getRuntimeStatistics().transactionRollbacks).toBe(1);
  });

  it("rollback odtwarza plik usunięty przez wcześniejszą operację", async () => {
    const service = await LocalChangeService.create(
      options("write", "approved", {
        transactionHook: async (index) => {
          if (index === 1) throw new Error("injected");
        },
      }),
    );
    await service.prepareDeleteFile({
      path: "src/a.ts",
      expectedHash: await hash("src/a.ts"),
      reason: "usunięcie",
    });
    await service.prepareCreateFile({ path: "new.ts", content: "new\n", reason: "druga" });
    await expect(service.applyChangeSet()).rejects.toBeInstanceOf(TransactionFailedError);
    await expect(readFile(join(root, "src", "a.ts"), "utf8")).resolves.toBe(
      "export const a = 1;\n",
    );
    await expect(stat(join(root, "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rollback cofa przeniesienie wykonane przed późniejszym błędem", async () => {
    const service = await LocalChangeService.create(
      options("write", "approved", {
        transactionHook: async (index) => {
          if (index === 1) throw new Error("injected");
        },
      }),
    );
    await service.prepareMoveFile({
      sourcePath: "src/a.ts",
      destinationPath: "lib/a.ts",
      expectedSourceHash: await hash("src/a.ts"),
      reason: "przeniesienie",
    });
    await service.prepareCreateFile({ path: "new.ts", content: "new\n", reason: "druga" });
    await expect(service.applyChangeSet()).rejects.toBeInstanceOf(TransactionFailedError);
    await expect(readFile(join(root, "src", "a.ts"), "utf8")).resolves.toBe(
      "export const a = 1;\n",
    );
    await expect(stat(join(root, "lib", "a.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blokuje ponowną aplikację tego samego ChangeSet", async () => {
    const service = await LocalChangeService.create(options("write"));
    await service.prepareCreateFile({ path: "new.ts", content: "new\n", reason: "test" });
    await service.applyChangeSet();
    await expect(service.applyChangeSet()).rejects.toBeInstanceOf(ChangeSetAlreadyAppliedError);
  });

  it("przywraca checkpoint, tworząc wcześniej checkpoint bezpieczeństwa", async () => {
    const service = await LocalChangeService.create(options("write"));
    await service.preparePatch({
      path: "src/a.ts",
      expectedHash: await hash("src/a.ts"),
      replacements: [{ oldText: "a = 1", newText: "a = 2" }],
      reason: "test",
    });
    const applied = await service.applyChangeSet();
    const restored = await service.restoreCheckpoint(applied.checkpointId ?? "", "cofnięcie testu");
    expect(restored.safetyCheckpointId).not.toBe(applied.checkpointId);
    await expect(readFile(join(root, "src", "a.ts"), "utf8")).resolves.toBe(
      "export const a = 1;\n",
    );
  });

  it("zapisuje metadane audytu bez zawartości plików", async () => {
    const service = await LocalChangeService.create(options("write"));
    await service.prepareCreateFile({
      path: "new.ts",
      content: "UNIKALNA_TRESC_SEKRETNA\n",
      reason: "nowy plik",
    });
    await service.applyChangeSet();
    const log = await readFile(join(root, ".agent", "history", "changes.jsonl"), "utf8");
    expect(log).toContain('"operation":"create_file"');
    expect(log).not.toContain("UNIKALNA_TRESC_SEKRETNA");
  });

  it("liczy statystyki operacji zapisu", async () => {
    const service = await LocalChangeService.create(options("write"));
    await service.preparePatch({
      path: "src/a.ts",
      expectedHash: await hash("src/a.ts"),
      replacements: [{ oldText: "a = 1", newText: "a = 2" }],
      reason: "test",
    });
    await service.prepareCreateFile({ path: "new.ts", content: "new\n", reason: "test" });
    await service.applyChangeSet();
    expect(service.getRuntimeStatistics()).toMatchObject({
      patchesPrepared: 1,
      patchesApplied: 1,
      filesCreated: 1,
      writeConflicts: 0,
      transactionRollbacks: 0,
    });
  });
});

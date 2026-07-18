import { z } from "zod";

import type { ChangeService } from "@local-code-agent/change-engine";

import type { ToolRegistry } from "./toolRegistry.js";
import { createToolDefinition } from "./toolTypes.js";

const emptySchema = z.object({}).strict();
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/u, "Wymagany jest hash SHA-256.");
const reasonSchema = z.string().trim().min(3).max(1_000);

const preparePatchSchema = z
  .object({
    path: z.string().trim().min(1),
    expectedHash: hashSchema,
    replacements: z
      .array(
        z
          .object({
            oldText: z.string().min(1),
            newText: z.string(),
            expectedOccurrences: z.number().int().min(1).default(1),
          })
          .strict(),
      )
      .max(10_000),
    lineRangeReplacements: z
      .array(
        z
          .object({
            startLine: z.number().int().min(1),
            endLine: z.number().int().min(1),
            oldTextHash: hashSchema,
            newText: z.string(),
          })
          .strict(),
      )
      .max(10_000)
      .optional(),
    reason: reasonSchema,
  })
  .strict();

const createFileSchema = z
  .object({
    path: z.string().trim().min(1),
    content: z.string(),
    reason: reasonSchema,
  })
  .strict();

const deleteFileSchema = z
  .object({
    path: z.string().trim().min(1),
    expectedHash: hashSchema,
    reason: reasonSchema,
  })
  .strict();

const moveFileSchema = z
  .object({
    sourcePath: z.string().trim().min(1),
    destinationPath: z.string().trim().min(1),
    expectedSourceHash: hashSchema,
    reason: reasonSchema,
  })
  .strict();

const operationSchema = z.object({ operationId: z.string().uuid() }).strict();
const fileDiffSchema = z.object({ path: z.string().trim().min(1) }).strict();
const applySchema = z
  .object({ description: z.string().trim().min(1).max(1_000).optional() })
  .strict();
const restoreSchema = z
  .object({
    checkpointId: z.string().trim().min(1),
    reason: reasonSchema,
  })
  .strict();

function register<TArgs, TResult>(
  registry: ToolRegistry,
  name: string,
  description: string,
  schema: z.ZodType<TArgs>,
  execute: (args: TArgs) => Promise<TResult>,
): void {
  registry.register({
    name,
    description,
    schema,
    definition: createToolDefinition(name, description, schema),
    execute,
  });
}

export interface RegisterChangeToolsOptions {
  allowFileDelete: boolean;
  allowFileMove: boolean;
  beforeApply?: () => Promise<void>;
  afterApply?: (result: Awaited<ReturnType<ChangeService["applyChangeSet"]>>) => Promise<unknown>;
  allowApply?: boolean;
}

export function registerChangeTools(
  registry: ToolRegistry,
  changes: ChangeService,
  options: RegisterChangeToolsOptions,
): void {
  register(
    registry,
    "list_checkpoints",
    "Listuje lokalne checkpointy bez zmiany plików.",
    emptySchema,
    async () => ({
      checkpoints: await changes.listCheckpoints(),
    }),
  );

  if (changes.getMode() === "readonly") return;

  register(
    registry,
    "prepare_patch",
    "Waliduje precyzyjny patch względem hasha i dodaje go do bieżącego ChangeSet bez zapisu.",
    preparePatchSchema,
    ({ path, expectedHash, replacements, lineRangeReplacements, reason }) =>
      changes.preparePatch({
        path,
        expectedHash,
        replacements,
        reason,
        ...(lineRangeReplacements === undefined ? {} : { lineRangeReplacements }),
      }),
  );
  register(
    registry,
    "create_file",
    "Przygotowuje utworzenie nowego pliku tekstowego bez nadpisywania istniejącego pliku.",
    createFileSchema,
    (args) => changes.prepareCreateFile(args),
  );
  if (options.allowFileDelete) {
    register(
      registry,
      "delete_file",
      "Przygotowuje usunięcie pliku po sprawdzeniu jego aktualnego hasha.",
      deleteFileSchema,
      (args) => changes.prepareDeleteFile(args),
    );
  }
  if (options.allowFileMove) {
    register(
      registry,
      "move_file",
      "Przygotowuje przeniesienie pliku do nieistniejącego celu po sprawdzeniu hasha.",
      moveFileSchema,
      (args) => changes.prepareMoveFile(args),
    );
  }
  register(
    registry,
    "get_current_change_set",
    "Zwraca operacje oraz podsumowanie bieżącego ChangeSet.",
    emptySchema,
    async () => changes.getCurrentChangeSet(),
  );
  register(
    registry,
    "remove_change_operation",
    "Usuwa niezastosowaną operację z bieżącego ChangeSet.",
    operationSchema,
    ({ operationId }) => changes.removeChangeOperation(operationId),
  );
  register(
    registry,
    "clear_change_set",
    "Usuwa wszystkie niezastosowane operacje z bieżącego ChangeSet.",
    emptySchema,
    async () => changes.clearChangeSet(),
  );
  register(
    registry,
    "preview_changes",
    "Ponownie waliduje cały ChangeSet i zwraca unified diff, konflikty i podsumowanie.",
    emptySchema,
    async () => changes.previewChangeSet(),
  );
  register(
    registry,
    "get_file_diff",
    "Zwraca pełny diff pojedynczego pliku z bieżącego ChangeSet.",
    fileDiffSchema,
    async ({ path }) => ({ path, diff: await changes.getFileDiff(path) }),
  );

  if (changes.getMode() !== "write" || options.allowApply === false) return;

  register(
    registry,
    "apply_changes",
    "Stosuje cały ChangeSet transakcyjnie; nie omija wymaganego potwierdzenia użytkownika.",
    applySchema,
    async () => {
      await options.beforeApply?.();
      const result = await changes.applyChangeSet();
      const verification = await options.afterApply?.(result);
      return verification === undefined ? result : { ...result, verification };
    },
  );
  register(
    registry,
    "restore_checkpoint",
    "Przywraca wskazany checkpoint po potwierdzeniu i tworzy checkpoint bezpieczeństwa.",
    restoreSchema,
    ({ checkpointId, reason }) => changes.restoreCheckpoint(checkpointId, reason),
  );
}

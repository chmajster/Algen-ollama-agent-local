import { link, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { AtomicWriter } from "./atomicWriter.js";
import {
  ChangeEngineError,
  FileChangedSinceReadError,
  RollbackFailedError,
  TransactionFailedError,
} from "./errors.js";
import type { CheckpointService } from "./checkpointService.js";
import type { FileOperation } from "./changeTypes.js";
import { FileHashService } from "./fileHashService.js";

export interface PreparedTransactionOperation {
  operation: FileOperation;
  path?: string;
  sourcePath?: string;
  destinationPath?: string;
  content?: Uint8Array;
}

export interface TransactionManagerOptions {
  beforeOperation?: (operationIndex: number, operation: FileOperation) => Promise<void>;
}

export interface TransactionResult {
  appliedOperations: number;
  restoredFiles: number;
}

function abortError(): Error {
  const error = new Error("Transakcja została przerwana.");
  error.name = "AbortError";
  return error;
}

function operationPaths(operation: FileOperation): string[] {
  return operation.type === "move_file"
    ? [operation.sourcePath, operation.destinationPath]
    : [operation.path];
}

export class TransactionManager {
  public constructor(
    private readonly checkpoints: CheckpointService,
    private readonly writer = new AtomicWriter(),
    private readonly options: TransactionManagerOptions = {},
    private readonly hashes = new FileHashService(),
  ) {}

  private async verifyCurrentContent(prepared: PreparedTransactionOperation): Promise<void> {
    const operation = prepared.operation;
    const expectedHash =
      operation.type === "apply_patch" || operation.type === "delete_file"
        ? operation.expectedHash
        : operation.type === "move_file"
          ? operation.expectedSourceHash
          : undefined;
    const sourcePath = operation.type === "move_file" ? prepared.sourcePath : prepared.path;
    if (expectedHash === undefined || sourcePath === undefined) return;
    const actualHash = await this.hashes.hashFile(sourcePath);
    if (actualHash !== expectedHash) {
      const logicalPath = operation.type === "move_file" ? operation.sourcePath : operation.path;
      throw new FileChangedSinceReadError(undefined, logicalPath);
    }
  }

  private async applyOperation(prepared: PreparedTransactionOperation): Promise<void> {
    switch (prepared.operation.type) {
      case "apply_patch": {
        if (prepared.path === undefined || prepared.content === undefined)
          throw new Error("Brak danych patcha.");
        await this.writer.replaceFile(prepared.path, prepared.content);
        break;
      }
      case "create_file": {
        if (prepared.path === undefined || prepared.content === undefined)
          throw new Error("Brak danych pliku.");
        await this.writer.createFile(prepared.path, prepared.content);
        break;
      }
      case "delete_file": {
        if (prepared.path === undefined) throw new Error("Brak ścieżki usuwanego pliku.");
        await unlink(prepared.path);
        break;
      }
      case "move_file": {
        if (prepared.sourcePath === undefined || prepared.destinationPath === undefined) {
          throw new Error("Brak ścieżek przenoszonego pliku.");
        }
        await mkdir(dirname(prepared.destinationPath), { recursive: true });
        await link(prepared.sourcePath, prepared.destinationPath);
        await unlink(prepared.sourcePath);
        break;
      }
    }
  }

  public async apply(
    operations: readonly PreparedTransactionOperation[],
    checkpointId: string,
    signal?: AbortSignal,
  ): Promise<TransactionResult> {
    let appliedOperations = 0;
    const touchedPaths = new Set<string>();
    try {
      for (let index = 0; index < operations.length; index += 1) {
        if (signal?.aborted ?? false) throw abortError();
        const prepared = operations[index];
        if (prepared === undefined) continue;
        await this.options.beforeOperation?.(index, prepared.operation);
        if (signal?.aborted === true) throw abortError();
        await this.verifyCurrentContent(prepared);
        for (const path of operationPaths(prepared.operation)) touchedPaths.add(path);
        await this.applyOperation(prepared);
        appliedOperations += 1;
      }
      return { appliedOperations, restoredFiles: 0 };
    } catch (error: unknown) {
      if (touchedPaths.size === 0) throw error;
      try {
        const restoredFiles = await this.checkpoints.restore(checkpointId, [...touchedPaths]);
        if (error instanceof ChangeEngineError) throw error;
        throw new TransactionFailedError(
          `Transakcja nie powiodła się. Wycofano ${restoredFiles} plików.`,
          undefined,
          { cause: error },
        );
      } catch (rollbackError: unknown) {
        if (rollbackError === error && error instanceof ChangeEngineError) throw error;
        if (rollbackError instanceof TransactionFailedError) throw rollbackError;
        throw new RollbackFailedError(undefined, undefined, {
          cause: rollbackError,
        });
      }
    }
  }
}

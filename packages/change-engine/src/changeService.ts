import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import { bufferLooksBinary } from "@local-code-agent/workspace";

import { AtomicWriter } from "./atomicWriter.js";
import { AuditLogService } from "./auditLogService.js";
import { ChangeValidator } from "./changeValidator.js";
import { CheckpointService } from "./checkpointService.js";
import { DiffService } from "./diffService.js";
import type { FileDiffResult } from "./diffService.js";
import {
  BinaryFileWriteError,
  ChangeEngineError,
  ChangeSetAlreadyAppliedError,
  ChangeSetConflictError,
  EmptyPatchError,
  FileChangedSinceReadError,
  FileDeleteDisabledError,
  FileMoveDisabledError,
  FileNotFoundForWriteError,
  RollbackFailedError,
  TransactionFailedError,
  UnsupportedWriteEncodingError,
  WriteConfirmationRejectedError,
  WriteConfirmationRequiredError,
  WriteLimitExceededError,
  WriteModeDisabledError,
} from "./errors.js";
import { FileHashService } from "./fileHashService.js";
import { PatchEngine } from "./patchEngine.js";
import { TransactionManager } from "./transactionManager.js";
import type { PreparedTransactionOperation } from "./transactionManager.js";
import type {
  AccessMode,
  ApplyChangeSetOptions,
  ApplyChangeSetResult,
  ApplyPatchOperation,
  AuditLogEntry,
  ChangeConflict,
  ChangeOperationSummary,
  ChangePreview,
  ChangeRuntimeStatistics,
  ChangeService,
  ChangeServiceOptions,
  ChangeSessionSnapshot,
  ChangeSet,
  ChangeTotals,
  CheckpointSummary,
  ConfirmationDecision,
  CreateChangeSetInput,
  CreateFileOperation,
  CurrentChangeSetResult,
  DeleteFileOperation,
  FileOperation,
  MoveFileOperation,
  PrepareCreateFileInput,
  PrepareDeleteFileInput,
  PreparedChangeResult,
  PrepareMoveFileInput,
  PreparePatchInput,
  RestoreCheckpointResult,
  RollbackResult,
} from "./changeTypes.js";

interface ValidatedChangeSet {
  preview: ChangePreview;
  operations: PreparedTransactionOperation[];
  hashesAfter: Map<string, string | undefined>;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function decodeText(bytes: Uint8Array, path: string): string {
  const hadBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(hadBom ? bytes.subarray(3) : bytes);
  } catch (error: unknown) {
    throw new UnsupportedWriteEncodingError(undefined, path, { cause: error });
  }
}

function normalizeNewFileEol(content: string, mode: ChangeServiceOptions["defaultEol"]): string {
  const eol = mode === "crlf" || (mode === "auto" && process.platform === "win32") ? "\r\n" : "\n";
  return content.replace(/\r\n|\r|\n/gu, eol);
}

function operationPaths(operation: FileOperation): string[] {
  switch (operation.type) {
    case "move_file":
      return [operation.sourcePath, operation.destinationPath];
    default:
      return [operation.path];
  }
}

function operationSummary(operation: FileOperation): ChangeOperationSummary {
  return {
    id: operation.id,
    type: operation.type,
    ...(operation.type === "move_file"
      ? {
          sourcePath: operation.sourcePath,
          destinationPath: operation.destinationPath,
        }
      : { path: operation.path }),
    reason: operation.reason,
    additions: operation.additions,
    deletions: operation.deletions,
  };
}

function totals(operations: readonly FileOperation[]): ChangeTotals {
  return {
    filesChanged: operations.filter((operation) => operation.type === "apply_patch").length,
    filesCreated: operations.filter((operation) => operation.type === "create_file").length,
    filesDeleted: operations.filter((operation) => operation.type === "delete_file").length,
    filesMoved: operations.filter((operation) => operation.type === "move_file").length,
    additions: operations.reduce((sum, operation) => sum + operation.additions, 0),
    deletions: operations.reduce((sum, operation) => sum + operation.deletions, 0),
  };
}

function conflictFrom(error: unknown): ChangeConflict {
  if (error instanceof ChangeEngineError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.path === undefined ? {} : { path: error.path }),
    };
  }
  return {
    code: "CHANGE_VALIDATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

export class LocalChangeService implements ChangeService {
  private readonly changes = new Map<string, ChangeSet>();
  private readonly hashes = new FileHashService();
  private readonly patchEngine = new PatchEngine(this.hashes);
  private readonly diffService: DiffService;
  private readonly checkpoints: CheckpointService;
  private readonly audit: AuditLogService;
  private readonly transaction: TransactionManager;
  private readonly statistics: ChangeRuntimeStatistics = {
    patchesPrepared: 0,
    patchesApplied: 0,
    filesCreated: 0,
    filesDeleted: 0,
    filesMoved: 0,
    writeConflicts: 0,
    transactionRollbacks: 0,
    checkpointBytesCreated: 0,
  };
  private current: ChangeSet;
  private lastPreview: ChangePreview | undefined;

  private constructor(
    private readonly options: ChangeServiceOptions,
    private readonly validator: ChangeValidator,
  ) {
    this.diffService = new DiffService(options.limits.maxDiffChars);
    const writer = new AtomicWriter();
    this.checkpoints = new CheckpointService(
      {
        workspaceRoot: validator.workspaceRoot,
        retention: options.checkpointRetention,
        maxTotalBytes: options.checkpointMaxTotalBytes,
      },
      validator,
      writer,
      this.hashes,
    );
    this.audit = new AuditLogService(validator.workspaceRoot);
    this.transaction = new TransactionManager(this.checkpoints, writer, {
      ...(options.transactionHook === undefined
        ? {}
        : { beforeOperation: options.transactionHook }),
    });
    this.current = this.newChangeSet();
    this.changes.set(this.current.id, this.current);
  }

  public static async create(options: ChangeServiceOptions): Promise<LocalChangeService> {
    const validator = await ChangeValidator.create({
      workspaceRoot: options.workspaceRoot,
      allowSensitiveFileWrite: options.allowSensitiveFileWrite,
      allowSymlinkWrite: options.allowSymlinkWrite,
    });
    await new AtomicWriter().cleanupWorkspaceTemporaryFiles(validator.workspaceRoot);
    return new LocalChangeService(options, validator);
  }

  private newChangeSet(input: CreateChangeSetInput = {}): ChangeSet {
    return {
      id: randomUUID(),
      ...(input.task === undefined ? {} : { task: input.task }),
      createdAt: new Date().toISOString(),
      workspaceRoot: this.validator.workspaceRoot,
      operations: input.operations === undefined ? [] : [...input.operations],
      status: "draft",
    };
  }

  private requireEditingMode(): void {
    if (this.options.mode === "readonly") {
      throw new WriteModeDisabledError(
        "Narzędzia przygotowujące zmiany są wyłączone w trybie readonly.",
      );
    }
  }

  private assertMutable(): void {
    if (["applying", "applied", "failed", "rolled_back"].includes(this.current.status)) {
      throw new ChangeSetConflictError("Bieżący ChangeSet nie może być już modyfikowany.");
    }
  }

  private assertOperationCapacity(additionalOperations = 1): void {
    if (
      this.current.operations.length + additionalOperations >
      this.options.limits.maxChangeOperations
    ) {
      throw new WriteLimitExceededError(
        `ChangeSet może zawierać maksymalnie ${this.options.limits.maxChangeOperations} operacji.`,
      );
    }
  }

  private async currentHash(path: string): Promise<string> {
    return this.hashes.hashFile(path);
  }

  private assertExpectedHash(actual: string, expected: string, path: string): void {
    if (actual !== expected) {
      this.statistics.writeConflicts += 1;
      throw new FileChangedSinceReadError(undefined, path);
    }
  }

  private async validateOperation(operation: FileOperation): Promise<{
    prepared: PreparedTransactionOperation;
    diff: FileDiffResult;
    hashAfter: string | undefined;
    writeBytes: number;
  }> {
    switch (operation.type) {
      case "apply_patch": {
        const path = await this.validator.existingFile(operation.path);
        await this.validator.assertTextFile(path);
        const bytes = await readFile(path.absolutePath);
        this.assertExpectedHash(
          this.hashes.hashBytes(bytes),
          operation.expectedHash,
          path.relativePath,
        );
        const patched = this.patchEngine.apply(bytes, operation.patch, path.relativePath);
        const oldContent = decodeText(bytes, path.relativePath);
        const diff = this.diffService.modified(path.relativePath, oldContent, patched.content);
        return {
          prepared: { operation, path: path.absolutePath, content: patched.bytes },
          diff,
          hashAfter: patched.newHash,
          writeBytes: patched.bytes.length,
        };
      }
      case "create_file": {
        const path = await this.validator.newFile(operation.path);
        const content = normalizeNewFileEol(operation.content, this.options.defaultEol);
        const bytes = Buffer.from(content, "utf8");
        if (bytes.length > this.options.limits.maxCreatedFileBytes) {
          throw new WriteLimitExceededError(
            `Nowy plik przekracza limit ${this.options.limits.maxCreatedFileBytes} bajtów.`,
            path.relativePath,
          );
        }
        if (bufferLooksBinary(bytes)) throw new BinaryFileWriteError(undefined, path.relativePath);
        return {
          prepared: { operation, path: path.absolutePath, content: bytes },
          diff: this.diffService.created(path.relativePath, content),
          hashAfter: this.hashes.hashBytes(bytes),
          writeBytes: bytes.length,
        };
      }
      case "delete_file": {
        if (!this.options.allowFileDelete) throw new FileDeleteDisabledError();
        const path = await this.validator.existingFile(operation.path);
        await this.validator.assertTextFile(path);
        const bytes = await readFile(path.absolutePath);
        this.assertExpectedHash(
          this.hashes.hashBytes(bytes),
          operation.expectedHash,
          path.relativePath,
        );
        return {
          prepared: { operation, path: path.absolutePath },
          diff: this.diffService.deleted(path.relativePath, decodeText(bytes, path.relativePath)),
          hashAfter: undefined,
          writeBytes: 0,
        };
      }
      case "move_file": {
        if (!this.options.allowFileMove) throw new FileMoveDisabledError();
        const source = await this.validator.existingFile(operation.sourcePath);
        await this.validator.assertTextFile(source);
        const destination = await this.validator.newFile(operation.destinationPath);
        const actualHash = await this.currentHash(source.absolutePath);
        this.assertExpectedHash(actualHash, operation.expectedSourceHash, source.relativePath);
        return {
          prepared: {
            operation,
            sourcePath: source.absolutePath,
            destinationPath: destination.absolutePath,
          },
          diff: this.diffService.moved(source.relativePath, destination.relativePath),
          hashAfter: actualHash,
          writeBytes: 0,
        };
      }
    }
  }

  private checkPathConflicts(operations: readonly FileOperation[]): ChangeConflict[] {
    const owners = new Map<string, string>();
    const conflicts: ChangeConflict[] = [];
    for (const operation of operations) {
      for (const path of operationPaths(operation)) {
        const normalized = path.replaceAll("\\", "/").toLowerCase();
        const owner = owners.get(normalized);
        if (owner !== undefined) {
          conflicts.push({
            code: "CHANGE_SET_CONFLICT",
            message: `Operacje ${owner} i ${operation.id} dotyczą tej samej ścieżki.`,
            path: path.replaceAll("\\", "/"),
          });
        } else {
          owners.set(normalized, operation.id);
        }
      }
    }
    return conflicts;
  }

  private async validateChangeSet(changeSet: ChangeSet): Promise<ValidatedChangeSet> {
    const conflicts = this.checkPathConflicts(changeSet.operations);
    const prepared: PreparedTransactionOperation[] = [];
    const fileDiffs: FileDiffResult[] = [];
    const hashesAfter = new Map<string, string | undefined>();
    let totalWriteBytes = 0;

    if (changeSet.operations.length > this.options.limits.maxChangeOperations) {
      conflicts.push(conflictFrom(new WriteLimitExceededError()));
    }
    const uniquePaths = new Set(changeSet.operations.flatMap(operationPaths));
    if (uniquePaths.size > this.options.limits.maxChangedFiles) {
      conflicts.push(
        conflictFrom(
          new WriteLimitExceededError(
            `ChangeSet może obejmować maksymalnie ${this.options.limits.maxChangedFiles} plików.`,
          ),
        ),
      );
    }

    if (conflicts.length === 0) {
      for (const operation of changeSet.operations) {
        try {
          const result = await this.validateOperation(operation);
          prepared.push(result.prepared);
          fileDiffs.push(result.diff);
          const key = operation.type === "move_file" ? operation.destinationPath : operation.path;
          hashesAfter.set(key.replaceAll("\\", "/"), result.hashAfter);
          totalWriteBytes += result.writeBytes;
        } catch (error: unknown) {
          conflicts.push(conflictFrom(error));
        }
      }
    }
    if (totalWriteBytes > this.options.limits.maxTotalWriteBytes) {
      conflicts.push(
        conflictFrom(
          new WriteLimitExceededError(
            `Łączny zapis przekracza limit ${this.options.limits.maxTotalWriteBytes} bajtów.`,
          ),
        ),
      );
    }

    const combined = this.diffService.combine(fileDiffs);
    const preview: ChangePreview = {
      changeSetId: changeSet.id,
      operations: changeSet.operations.map(operationSummary),
      diff: combined.diff,
      fileDiffs: Object.fromEntries(fileDiffs.map((item) => [item.path, item.diff])),
      warnings: combined.truncated ? ["Diff został ograniczony przez skonfigurowany limit."] : [],
      conflicts,
      totals: totals(changeSet.operations),
      canApply: changeSet.operations.length > 0 && conflicts.length === 0,
      diffTruncated: combined.truncated,
    };
    return { preview, operations: prepared, hashesAfter };
  }

  private throwPreviewConflict(preview: ChangePreview): never {
    const conflict = preview.conflicts[0];
    if (conflict?.code === "FILE_CHANGED_SINCE_READ") {
      throw new FileChangedSinceReadError(conflict.message, conflict.path);
    }
    throw new ChangeSetConflictError(conflict?.message, conflict?.path);
  }

  private async addPreparedOperation(
    operation: FileOperation,
  ): Promise<{ result: PreparedChangeResult; diff: FileDiffResult; newHash: string }> {
    this.requireEditingMode();
    if (this.current.status === "applied" || this.current.status === "rolled_back") {
      this.current = this.newChangeSet({
        ...(this.current.task === undefined ? {} : { task: `Poprawka: ${this.current.task}` }),
      });
      this.changes.set(this.current.id, this.current);
    }
    this.assertMutable();
    this.assertOperationCapacity();
    if (this.checkPathConflicts([...this.current.operations, operation]).length > 0) {
      throw new ChangeSetConflictError();
    }
    const validated = await this.validateOperation(operation);
    const newHash = validated.hashAfter ?? this.hashes.hashBytes(Buffer.alloc(0));
    this.current.operations.push({
      ...operation,
      additions: validated.diff.additions,
      deletions: validated.diff.deletions,
    });
    this.current.status = "draft";
    this.lastPreview = undefined;
    return {
      result: {
        changeSetId: this.current.id,
        operationId: operation.id,
        valid: true,
        path: validated.diff.path,
        additions: validated.diff.additions,
        deletions: validated.diff.deletions,
        newHash,
        diff: validated.diff.diff,
        warnings: validated.diff.truncated ? ["Diff operacji został ograniczony."] : [],
      },
      diff: validated.diff,
      newHash,
    };
  }

  public async createChangeSet(input: CreateChangeSetInput = {}): Promise<ChangeSet> {
    this.requireEditingMode();
    if (this.current.operations.length > 0 && this.current.status !== "applied") {
      throw new ChangeSetConflictError("W tej sesji istnieje już aktywny ChangeSet.");
    }
    this.current = this.newChangeSet(input);
    this.changes.set(this.current.id, this.current);
    return structuredClone(this.current);
  }

  public async preparePatch(input: PreparePatchInput): Promise<PreparedChangeResult> {
    const replacementCount = input.replacements.length + (input.lineRangeReplacements?.length ?? 0);
    if (replacementCount === 0) throw new EmptyPatchError();
    if (replacementCount > this.options.limits.maxPatchReplacements) {
      throw new WriteLimitExceededError(
        `Patch może zawierać maksymalnie ${this.options.limits.maxPatchReplacements} zamian.`,
      );
    }
    const operation: ApplyPatchOperation = {
      id: randomUUID(),
      type: "apply_patch",
      path: input.path,
      expectedHash: input.expectedHash,
      patch: {
        replacements: input.replacements,
        ...(input.lineRangeReplacements === undefined
          ? {}
          : { lineRangeReplacements: input.lineRangeReplacements }),
      },
      reason: input.reason,
      additions: 0,
      deletions: 0,
    };
    const prepared = await this.addPreparedOperation(operation);
    this.statistics.patchesPrepared += 1;
    return prepared.result;
  }

  public async prepareCreateFile(input: PrepareCreateFileInput): Promise<PreparedChangeResult> {
    const operation: CreateFileOperation = {
      id: randomUUID(),
      type: "create_file",
      path: input.path,
      content: input.content,
      overwrite: false,
      reason: input.reason,
      additions: 0,
      deletions: 0,
    };
    return (await this.addPreparedOperation(operation)).result;
  }

  public async prepareDeleteFile(input: PrepareDeleteFileInput): Promise<PreparedChangeResult> {
    const operation: DeleteFileOperation = {
      id: randomUUID(),
      type: "delete_file",
      path: input.path,
      expectedHash: input.expectedHash,
      reason: input.reason,
      additions: 0,
      deletions: 0,
    };
    return (await this.addPreparedOperation(operation)).result;
  }

  public async prepareMoveFile(input: PrepareMoveFileInput): Promise<PreparedChangeResult> {
    const operation: MoveFileOperation = {
      id: randomUUID(),
      type: "move_file",
      sourcePath: input.sourcePath,
      destinationPath: input.destinationPath,
      expectedSourceHash: input.expectedSourceHash,
      overwrite: false,
      reason: input.reason,
      additions: 0,
      deletions: 0,
    };
    return (await this.addPreparedOperation(operation)).result;
  }

  public async previewChangeSet(changeSet = this.current): Promise<ChangePreview> {
    this.requireEditingMode();
    const validated = await this.validateChangeSet(changeSet);
    changeSet.status = validated.preview.canApply ? "previewed" : "draft";
    this.lastPreview = validated.preview;
    return validated.preview;
  }

  private async confirmation(
    kind: "apply" | "restore",
    preview?: ChangePreview,
    checkpointId?: string,
    reason?: string,
  ): Promise<ConfirmationDecision> {
    if (!this.options.requireWriteConfirmation) return "approved";
    if (this.options.confirmationProvider === undefined) return "pending";
    return this.options.confirmationProvider({
      kind,
      ...(preview === undefined ? {} : { preview }),
      ...(checkpointId === undefined ? {} : { checkpointId }),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private checkpointPaths(operations: readonly FileOperation[]): string[] {
    return operations.flatMap(operationPaths);
  }

  private async verifyApplied(
    operations: readonly FileOperation[],
    hashesAfter: ReadonlyMap<string, string | undefined>,
  ): Promise<void> {
    for (const operation of operations) {
      if (operation.type === "delete_file") {
        try {
          await lstat((await this.validator.target(operation.path)).absolutePath);
          throw new TransactionFailedError("Usunięty plik nadal istnieje.", operation.path);
        } catch (error: unknown) {
          if (!isMissing(error)) throw error;
        }
        continue;
      }
      if (operation.type === "move_file") {
        const source = await this.validator.target(operation.sourcePath);
        try {
          await lstat(source.absolutePath);
          throw new TransactionFailedError("Źródło przeniesionego pliku nadal istnieje.");
        } catch (error: unknown) {
          if (!isMissing(error)) throw error;
        }
        const destination = await this.validator.existingFile(operation.destinationPath);
        this.assertExpectedHash(
          await this.currentHash(destination.absolutePath),
          operation.expectedSourceHash,
          destination.relativePath,
        );
        continue;
      }
      const target = await this.validator.existingFile(operation.path);
      const expected = hashesAfter.get(operation.path.replaceAll("\\", "/"));
      if (expected === undefined)
        throw new TransactionFailedError("Brak oczekiwanego hasha zapisu.");
      this.assertExpectedHash(
        await this.currentHash(target.absolutePath),
        expected,
        target.relativePath,
      );
    }
  }

  private auditEntry(
    operation: FileOperation,
    result: AuditLogEntry["result"],
    errorCode?: string,
  ): AuditLogEntry {
    return {
      timestamp: new Date().toISOString(),
      sessionId: this.options.sessionId,
      changeSetId: this.current.id,
      operation: operation.type,
      ...(operation.type === "move_file"
        ? { sourcePath: operation.sourcePath, destinationPath: operation.destinationPath }
        : { path: operation.path }),
      result,
      ...(errorCode === undefined ? {} : { errorCode }),
    };
  }

  public async applyChangeSet(
    changeSet = this.current,
    options: ApplyChangeSetOptions = {},
  ): Promise<ApplyChangeSetResult> {
    if (this.options.mode !== "write") throw new WriteModeDisabledError();
    if (changeSet.status === "applied") throw new ChangeSetAlreadyAppliedError();

    const initial = await this.validateChangeSet(changeSet);
    this.lastPreview = initial.preview;
    if (!initial.preview.canApply) {
      this.throwPreviewConflict(initial.preview);
    }
    const decision = await this.confirmation("apply", initial.preview);
    if (decision === "pending") {
      changeSet.status = "pending_confirmation";
      return {
        changeSetId: changeSet.id,
        status: "pending_confirmation",
        preview: initial.preview,
      };
    }
    if (decision === "rejected") {
      changeSet.status = "rejected";
      return { changeSetId: changeSet.id, status: "rejected", preview: initial.preview };
    }

    const validated = await this.validateChangeSet(changeSet);
    if (!validated.preview.canApply) this.throwPreviewConflict(validated.preview);
    const checkpoint = await this.checkpoints.create(
      changeSet.id,
      changeSet.task,
      this.checkpointPaths(changeSet.operations),
    );
    this.statistics.checkpointBytesCreated += checkpoint.totalBytes;
    changeSet.checkpointId = checkpoint.manifest.id;
    changeSet.status = "applying";

    let transactionCompleted = false;
    try {
      await this.transaction.apply(validated.operations, checkpoint.manifest.id, options.signal);
      transactionCompleted = true;
      await this.verifyApplied(changeSet.operations, validated.hashesAfter);
      for (const operation of changeSet.operations) {
        await this.audit.append(this.auditEntry(operation, "success"));
      }
      changeSet.status = "applied";
      const summary = totals(changeSet.operations);
      this.statistics.patchesApplied += summary.filesChanged;
      this.statistics.filesCreated += summary.filesCreated;
      this.statistics.filesDeleted += summary.filesDeleted;
      this.statistics.filesMoved += summary.filesMoved;
      return {
        changeSetId: changeSet.id,
        status: "applied",
        preview: validated.preview,
        checkpointId: checkpoint.manifest.id,
      };
    } catch (error: unknown) {
      changeSet.status = "failed";
      this.statistics.transactionRollbacks += 1;
      if (
        transactionCompleted &&
        !(error instanceof TransactionFailedError) &&
        !(error instanceof RollbackFailedError)
      ) {
        try {
          await this.checkpoints.restore(checkpoint.manifest.id);
        } catch (rollbackError: unknown) {
          throw new RollbackFailedError(undefined, undefined, { cause: rollbackError });
        }
      }
      const errorCode = error instanceof ChangeEngineError ? error.code : "TRANSACTION_FAILED";
      for (const operation of changeSet.operations) {
        try {
          await this.audit.append(this.auditEntry(operation, "failure", errorCode));
        } catch {
          // Nie maskuj pierwotnego błędu transakcji awarią pomocniczego dziennika.
        }
      }
      throw error;
    }
  }

  public async rollbackChangeSet(changeSetId: string): Promise<RollbackResult> {
    const changeSet = this.changes.get(changeSetId);
    if (changeSet?.checkpointId === undefined)
      throw new ChangeSetConflictError("ChangeSet nie ma checkpointu.");
    const restoredFiles = await this.checkpoints.restore(changeSet.checkpointId);
    changeSet.status = "rolled_back";
    this.statistics.transactionRollbacks += 1;
    return { changeSetId, checkpointId: changeSet.checkpointId, restoredFiles };
  }

  public async getChangeSet(changeSetId: string): Promise<ChangeSet | null> {
    const changeSet = this.changes.get(changeSetId);
    return changeSet === undefined ? null : structuredClone(changeSet);
  }

  public async getCurrentChangeSet(): Promise<CurrentChangeSetResult> {
    return {
      id: this.current.id,
      status: this.current.status,
      operations: this.current.operations.map(operationSummary),
      totals: totals(this.current.operations),
    };
  }

  public async removeChangeOperation(operationId: string): Promise<CurrentChangeSetResult> {
    this.requireEditingMode();
    this.assertMutable();
    const before = this.current.operations.length;
    this.current.operations = this.current.operations.filter(
      (operation) => operation.id !== operationId,
    );
    if (this.current.operations.length === before)
      throw new ChangeSetConflictError("Operacja nie istnieje.");
    this.current.status = "draft";
    this.lastPreview = undefined;
    return this.getCurrentChangeSet();
  }

  public async clearChangeSet(): Promise<CurrentChangeSetResult> {
    this.requireEditingMode();
    this.assertMutable();
    this.current.operations = [];
    this.current.status = "draft";
    this.lastPreview = undefined;
    return this.getCurrentChangeSet();
  }

  public async getFileDiff(path: string): Promise<string> {
    const preview = await this.previewChangeSet();
    const key = path.replaceAll("\\", "/");
    const diff = preview.fileDiffs[key];
    if (diff === undefined)
      throw new FileNotFoundForWriteError("Brak zmiany dla wskazanego pliku.", key);
    return diff;
  }

  public async listCheckpoints(): Promise<CheckpointSummary[]> {
    return this.checkpoints.list();
  }

  public async restoreCheckpoint(
    checkpointId: string,
    reason: string,
  ): Promise<RestoreCheckpointResult> {
    if (this.options.mode !== "write") throw new WriteModeDisabledError();
    const manifest = await this.checkpoints.getManifest(checkpointId);
    const decision = await this.confirmation("restore", undefined, checkpointId, reason);
    if (decision === "pending") throw new WriteConfirmationRequiredError();
    if (decision === "rejected") throw new WriteConfirmationRejectedError();
    const safety = await this.checkpoints.create(
      `restore-${checkpointId}`,
      `Checkpoint bezpieczeństwa przed restore: ${reason}`,
      manifest.files.map((file) => file.path),
    );
    this.statistics.checkpointBytesCreated += safety.totalBytes;
    try {
      const restoredFiles = await this.checkpoints.restore(checkpointId);
      return {
        checkpointId,
        safetyCheckpointId: safety.manifest.id,
        restoredFiles,
      };
    } catch (error: unknown) {
      try {
        await this.checkpoints.restore(safety.manifest.id);
      } catch (rollbackError: unknown) {
        throw new RollbackFailedError(undefined, undefined, { cause: rollbackError });
      }
      throw new TransactionFailedError(undefined, undefined, { cause: error });
    }
  }

  public getRuntimeStatistics(): ChangeRuntimeStatistics {
    return { ...this.statistics };
  }

  public getLastPreview(): ChangePreview | undefined {
    return this.lastPreview === undefined ? undefined : structuredClone(this.lastPreview);
  }

  public getMode(): AccessMode {
    return this.options.mode;
  }

  public getSessionSnapshot(): ChangeSessionSnapshot {
    return {
      changeSetId: this.current.id,
      mode: this.options.mode,
      status: this.current.status,
      totals: totals(this.current.operations),
      ...(this.current.checkpointId === undefined
        ? {}
        : { checkpointId: this.current.checkpointId }),
      previewAvailable: this.lastPreview !== undefined,
      statistics: this.getRuntimeStatistics(),
    };
  }
}

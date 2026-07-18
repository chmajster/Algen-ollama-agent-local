export type AccessMode = "readonly" | "preview" | "write";
export type DefaultEol = "auto" | "lf" | "crlf";
export type ChangeSetStatus =
  | "draft"
  | "previewed"
  | "pending_confirmation"
  | "rejected"
  | "applying"
  | "applied"
  | "failed"
  | "rolled_back";

export interface TextReplacement {
  oldText: string;
  newText: string;
  expectedOccurrences?: number;
}

export interface LineRangeReplacement {
  startLine: number;
  endLine: number;
  oldTextHash: string;
  newText: string;
}

export interface TextPatch {
  replacements: TextReplacement[];
  lineRangeReplacements?: LineRangeReplacement[];
}

interface FileOperationBase {
  id: string;
  reason: string;
  additions: number;
  deletions: number;
}

export interface ApplyPatchOperation extends FileOperationBase {
  type: "apply_patch";
  path: string;
  expectedHash: string;
  patch: TextPatch;
}

export interface CreateFileOperation extends FileOperationBase {
  type: "create_file";
  path: string;
  content: string;
  overwrite: false;
}

export interface DeleteFileOperation extends FileOperationBase {
  type: "delete_file";
  path: string;
  expectedHash: string;
}

export interface MoveFileOperation extends FileOperationBase {
  type: "move_file";
  sourcePath: string;
  destinationPath: string;
  expectedSourceHash: string;
  overwrite: false;
}

export type FileOperation =
  ApplyPatchOperation | CreateFileOperation | DeleteFileOperation | MoveFileOperation;

export interface ChangeSet {
  id: string;
  task?: string;
  createdAt: string;
  workspaceRoot: string;
  operations: FileOperation[];
  status: ChangeSetStatus;
  checkpointId?: string;
}

export interface CreateChangeSetInput {
  task?: string;
  operations?: FileOperation[];
}

export interface ChangeTotals {
  filesChanged: number;
  filesCreated: number;
  filesDeleted: number;
  filesMoved: number;
  additions: number;
  deletions: number;
}

export interface ChangeOperationSummary {
  id: string;
  type: FileOperation["type"];
  path?: string;
  sourcePath?: string;
  destinationPath?: string;
  reason: string;
  additions: number;
  deletions: number;
}

export interface CurrentChangeSetResult {
  id: string;
  status: ChangeSetStatus;
  operations: ChangeOperationSummary[];
  totals: ChangeTotals;
}

export interface ChangeConflict {
  code: string;
  message: string;
  path?: string;
}

export interface ChangePreview {
  changeSetId: string;
  operations: ChangeOperationSummary[];
  diff: string;
  fileDiffs: Record<string, string>;
  warnings: string[];
  conflicts: ChangeConflict[];
  totals: ChangeTotals;
  canApply: boolean;
  diffTruncated: boolean;
}

export interface PreparedChangeResult {
  changeSetId: string;
  operationId: string;
  valid: true;
  path: string;
  additions: number;
  deletions: number;
  newHash: string;
  diff: string;
  warnings: string[];
}

export interface PreparePatchInput {
  path: string;
  expectedHash: string;
  replacements: TextReplacement[];
  lineRangeReplacements?: LineRangeReplacement[];
  reason: string;
}

export interface PrepareCreateFileInput {
  path: string;
  content: string;
  reason: string;
}

export interface PrepareDeleteFileInput {
  path: string;
  expectedHash: string;
  reason: string;
}

export interface PrepareMoveFileInput {
  sourcePath: string;
  destinationPath: string;
  expectedSourceHash: string;
  reason: string;
}

export interface ApplyChangeSetOptions {
  signal?: AbortSignal;
}

export type ApplyChangeSetStatus = "applied" | "pending_confirmation" | "rejected";

export interface ApplyChangeSetResult {
  changeSetId: string;
  status: ApplyChangeSetStatus;
  preview: ChangePreview;
  checkpointId?: string;
}

export interface RollbackResult {
  changeSetId: string;
  checkpointId: string;
  restoredFiles: number;
}

export interface CheckpointFileEntry {
  path: string;
  existed: boolean;
  sha256?: string;
  sizeBytes?: number;
  mode?: number;
  backupPath?: string;
}

export interface CheckpointManifest {
  id: string;
  createdAt: string;
  changeSetId: string;
  task?: string;
  files: CheckpointFileEntry[];
}

export interface CheckpointSummary {
  id: string;
  createdAt: string;
  changeSetId: string;
  task?: string;
  filesCount: number;
  totalBytes: number;
}

export interface RestoreCheckpointResult {
  checkpointId: string;
  safetyCheckpointId: string;
  restoredFiles: number;
}

export interface ChangePlan {
  goal: string;
  filesToInspect: string[];
  filesExpectedToChange: string[];
  steps: Array<{
    id: string;
    description: string;
    verification: string;
  }>;
  risk: "low" | "medium" | "high";
}

export interface ChangeEngineLimits {
  maxChangedFiles: number;
  maxCreatedFileBytes: number;
  maxTotalWriteBytes: number;
  maxPatchReplacements: number;
  maxChangeOperations: number;
  maxDiffChars: number;
}

export interface ConfirmationContext {
  kind: "apply" | "restore";
  preview?: ChangePreview;
  checkpointId?: string;
  reason?: string;
}

export type ConfirmationDecision = "approved" | "rejected" | "pending";
export type ConfirmationProvider = (context: ConfirmationContext) => Promise<ConfirmationDecision>;

export interface ChangeServiceOptions {
  workspaceRoot: string;
  mode: AccessMode;
  requireWriteConfirmation: boolean;
  allowFileDelete: boolean;
  allowFileMove: boolean;
  allowSensitiveFileWrite: boolean;
  allowSymlinkWrite: boolean;
  defaultEol: DefaultEol;
  checkpointRetention: number;
  checkpointMaxTotalBytes: number;
  limits: ChangeEngineLimits;
  sessionId: string;
  confirmationProvider?: ConfirmationProvider;
  transactionHook?: (operationIndex: number, operation: FileOperation) => Promise<void>;
}

export interface ChangeRuntimeStatistics {
  patchesPrepared: number;
  patchesApplied: number;
  filesCreated: number;
  filesDeleted: number;
  filesMoved: number;
  writeConflicts: number;
  transactionRollbacks: number;
  checkpointBytesCreated: number;
}

export interface ChangeSessionSnapshot {
  changeSetId: string;
  mode: AccessMode;
  status: ChangeSetStatus;
  totals: ChangeTotals;
  checkpointId?: string;
  previewAvailable: boolean;
  statistics: ChangeRuntimeStatistics;
}

export interface ChangeService {
  createChangeSet(input?: CreateChangeSetInput): Promise<ChangeSet>;
  preparePatch(input: PreparePatchInput): Promise<PreparedChangeResult>;
  prepareCreateFile(input: PrepareCreateFileInput): Promise<PreparedChangeResult>;
  prepareDeleteFile(input: PrepareDeleteFileInput): Promise<PreparedChangeResult>;
  prepareMoveFile(input: PrepareMoveFileInput): Promise<PreparedChangeResult>;
  previewChangeSet(changeSet?: ChangeSet): Promise<ChangePreview>;
  applyChangeSet(
    changeSet?: ChangeSet,
    options?: ApplyChangeSetOptions,
  ): Promise<ApplyChangeSetResult>;
  rollbackChangeSet(changeSetId: string): Promise<RollbackResult>;
  getChangeSet(changeSetId: string): Promise<ChangeSet | null>;
  getCurrentChangeSet(): Promise<CurrentChangeSetResult>;
  removeChangeOperation(operationId: string): Promise<CurrentChangeSetResult>;
  clearChangeSet(): Promise<CurrentChangeSetResult>;
  getFileDiff(path: string): Promise<string>;
  listCheckpoints(): Promise<CheckpointSummary[]>;
  restoreCheckpoint(checkpointId: string, reason: string): Promise<RestoreCheckpointResult>;
  getRuntimeStatistics(): ChangeRuntimeStatistics;
  getLastPreview(): ChangePreview | undefined;
  getMode(): AccessMode;
  getSessionSnapshot(): ChangeSessionSnapshot;
}

export interface AuditLogEntry {
  timestamp: string;
  sessionId: string;
  changeSetId: string;
  operation: string;
  path?: string;
  sourcePath?: string;
  destinationPath?: string;
  result: "success" | "failure" | "preview";
  reason?: string;
  errorCode?: string;
}

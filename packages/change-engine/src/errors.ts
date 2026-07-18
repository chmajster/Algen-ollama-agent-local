export class ChangeEngineError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly recoverable = true,
    public readonly path: string | undefined = undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ChangeEngineError";
  }
}

function errorType(
  name: string,
  code: string,
  defaultMessage: string,
  recoverable = true,
): new (message?: string, path?: string, options?: ErrorOptions) => ChangeEngineError {
  return class extends ChangeEngineError {
    public constructor(message = defaultMessage, path?: string, options?: ErrorOptions) {
      super(code, message, recoverable, path, options);
      this.name = name;
    }
  };
}

export const WriteModeDisabledError = errorType(
  "WriteModeDisabledError",
  "WRITE_MODE_DISABLED",
  "Ta operacja wymaga trybu write.",
);
export const WriteConfirmationRequiredError = errorType(
  "WriteConfirmationRequiredError",
  "WRITE_CONFIRMATION_REQUIRED",
  "Zmiany oczekują na jawne potwierdzenie użytkownika.",
);
export const WriteConfirmationRejectedError = errorType(
  "WriteConfirmationRejectedError",
  "WRITE_CONFIRMATION_REJECTED",
  "Użytkownik odrzucił proponowane zmiany.",
  false,
);
export const FileChangedSinceReadError = errorType(
  "FileChangedSinceReadError",
  "FILE_CHANGED_SINCE_READ",
  "Plik został zmieniony od czasu jego odczytania.",
);
export const PatchTargetNotFoundError = errorType(
  "PatchTargetNotFoundError",
  "PATCH_TARGET_NOT_FOUND",
  "Fragment wskazany przez patch nie występuje w pliku.",
);
export const PatchOccurrenceMismatchError = errorType(
  "PatchOccurrenceMismatchError",
  "PATCH_OCCURRENCE_MISMATCH",
  "Liczba wystąpień fragmentu jest inna niż oczekiwana.",
);
export const OverlappingPatchError = errorType(
  "OverlappingPatchError",
  "OVERLAPPING_PATCH",
  "Co najmniej dwie zmiany patcha nakładają się.",
);
export const EmptyPatchError = errorType(
  "EmptyPatchError",
  "EMPTY_PATCH",
  "Patch nie zawiera rzeczywistej zmiany.",
);
export const FileAlreadyExistsError = errorType(
  "FileAlreadyExistsError",
  "FILE_ALREADY_EXISTS",
  "Plik docelowy już istnieje i nie zostanie nadpisany.",
);
export const FileNotFoundForWriteError = errorType(
  "FileNotFoundForWriteError",
  "FILE_NOT_FOUND_FOR_WRITE",
  "Plik przeznaczony do modyfikacji nie istnieje.",
);
export const ProtectedPathWriteError = errorType(
  "ProtectedPathWriteError",
  "PROTECTED_PATH_WRITE",
  "Zapis do chronionej ścieżki został zablokowany.",
);
export const SensitiveFileWriteError = errorType(
  "SensitiveFileWriteError",
  "SENSITIVE_FILE_WRITE",
  "Zapis pliku mogącego zawierać dane poufne został zablokowany.",
);
export const WriteLimitExceededError = errorType(
  "WriteLimitExceededError",
  "WRITE_LIMIT_EXCEEDED",
  "Proponowana zmiana przekracza skonfigurowany limit zapisu.",
);
export const ChangeSetConflictError = errorType(
  "ChangeSetConflictError",
  "CHANGE_SET_CONFLICT",
  "ChangeSet zawiera konfliktujące operacje.",
);
export const TransactionFailedError = errorType(
  "TransactionFailedError",
  "TRANSACTION_FAILED",
  "Transakcja zapisu nie powiodła się i została przerwana.",
);
export const RollbackFailedError = errorType(
  "RollbackFailedError",
  "ROLLBACK_FAILED",
  "Nie udało się w pełni wycofać transakcji.",
  false,
);
export const CheckpointNotFoundError = errorType(
  "CheckpointNotFoundError",
  "CHECKPOINT_NOT_FOUND",
  "Wskazany checkpoint nie istnieje.",
);
export const CheckpointLimitError = errorType(
  "CheckpointLimitError",
  "CHECKPOINT_LIMIT_EXCEEDED",
  "Checkpoint przekracza skonfigurowany limit przestrzeni.",
);
export const AtomicWriteError = errorType(
  "AtomicWriteError",
  "ATOMIC_WRITE_FAILED",
  "Atomowy zapis pliku nie powiódł się.",
);
export const InvalidFileNameError = errorType(
  "InvalidFileNameError",
  "INVALID_FILE_NAME",
  "Nazwa pliku jest nieprawidłowa dla bieżącej platformy.",
);
export const SymlinkWriteBlockedError = errorType(
  "SymlinkWriteBlockedError",
  "SYMLINK_WRITE_BLOCKED",
  "Zapis przez dowiązanie symboliczne został zablokowany.",
);
export const BinaryFileWriteError = errorType(
  "BinaryFileWriteError",
  "BINARY_FILE_WRITE_BLOCKED",
  "Modyfikowanie plików binarnych jest zablokowane.",
);
export const UnsupportedWriteEncodingError = errorType(
  "UnsupportedWriteEncodingError",
  "UNSUPPORTED_WRITE_ENCODING",
  "Plik nie jest poprawnym tekstem UTF-8 i nie może zostać zmodyfikowany.",
);
export const ChangeSetAlreadyAppliedError = errorType(
  "ChangeSetAlreadyAppliedError",
  "CHANGE_SET_ALREADY_APPLIED",
  "Ten ChangeSet został już zastosowany.",
);
export const FileDeleteDisabledError = errorType(
  "FileDeleteDisabledError",
  "FILE_DELETE_DISABLED",
  "Usuwanie plików jest wyłączone w konfiguracji.",
);
export const FileMoveDisabledError = errorType(
  "FileMoveDisabledError",
  "FILE_MOVE_DISABLED",
  "Przenoszenie plików jest wyłączone w konfiguracji.",
);

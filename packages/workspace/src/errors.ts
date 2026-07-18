export class WorkspaceError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly recoverable = true,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

export class WorkspaceNotFoundError extends WorkspaceError {
  public constructor(path: string, options?: ErrorOptions) {
    super(
      "WORKSPACE_NOT_FOUND",
      `Skonfigurowany workspace nie istnieje:\n${path}\n\nUstaw poprawną wartość AGENT_WORKSPACE.`,
      false,
      options,
    );
    this.name = "WorkspaceNotFoundError";
  }
}

export class WorkspaceAccessError extends WorkspaceError {
  public constructor(
    message = "Nie można odczytać wskazanej ścieżki w workspace.",
    options?: ErrorOptions,
  ) {
    super("WORKSPACE_ACCESS_ERROR", message, true, options);
    this.name = "WorkspaceAccessError";
  }
}

export class PathOutsideWorkspaceError extends WorkspaceError {
  public constructor() {
    super("PATH_OUTSIDE_WORKSPACE", "Ścieżka znajduje się poza dozwolonym workspace.");
    this.name = "PathOutsideWorkspaceError";
  }
}

export class SymlinkEscapeError extends WorkspaceError {
  public constructor() {
    super(
      "SYMLINK_ESCAPE",
      "Dowiązanie symboliczne prowadzi poza dozwolony workspace i zostało zablokowane.",
    );
    this.name = "SymlinkEscapeError";
  }
}

export class SensitiveFileAccessError extends WorkspaceError {
  public constructor(path: string) {
    super(
      "SENSITIVE_FILE_ACCESS",
      `Odczyt pliku został zablokowany, ponieważ może zawierać dane poufne:\n${path}\n\nAby świadomie zezwolić na takie pliki, ustaw:\nAGENT_ALLOW_SENSITIVE_FILES=true`,
    );
    this.name = "SensitiveFileAccessError";
  }
}

export class BinaryFileError extends WorkspaceError {
  public constructor(path: string) {
    super("BINARY_FILE", `Plik ${path} jest binarny i nie może zostać odczytany jako tekst.`);
    this.name = "BinaryFileError";
  }
}

export class FileTooLargeError extends WorkspaceError {
  public constructor(path: string, sizeBytes: number, limitBytes: number) {
    super(
      "FILE_TOO_LARGE",
      `Plik ${path} ma ${sizeBytes} bajtów i przekracza limit ${limitBytes} bajtów. Użyj read_file_range, aby odczytać mniejszy fragment.`,
    );
    this.name = "FileTooLargeError";
  }
}

export class UnsupportedEncodingError extends WorkspaceError {
  public constructor(path: string, options?: ErrorOptions) {
    super(
      "UNSUPPORTED_ENCODING",
      `Plik ${path} nie jest poprawnym tekstem UTF-8. Inne kodowania nie są automatycznie dekodowane.`,
      true,
      options,
    );
    this.name = "UnsupportedEncodingError";
  }
}

export class InvalidLineRangeError extends WorkspaceError {
  public constructor(message: string) {
    super("INVALID_LINE_RANGE", message);
    this.name = "InvalidLineRangeError";
  }
}

export class SearchPatternError extends WorkspaceError {
  public constructor(message: string, options?: ErrorOptions) {
    super("SEARCH_PATTERN_ERROR", message, true, options);
    this.name = "SearchPatternError";
  }
}

export class SearchLimitError extends WorkspaceError {
  public constructor(limit: number) {
    super("SEARCH_LIMIT_ERROR", `Limit wyników wyszukiwania musi mieścić się między 1 a ${limit}.`);
    this.name = "SearchLimitError";
  }
}

export class GitNotAvailableError extends WorkspaceError {
  public constructor(options?: ErrorOptions) {
    super(
      "GIT_NOT_AVAILABLE",
      "Program Git nie jest dostępny. Zainstaluj Git lub dodaj go do zmiennej PATH.",
      true,
      options,
    );
    this.name = "GitNotAvailableError";
  }
}

export class GitTimeoutError extends WorkspaceError {
  public constructor(options?: ErrorOptions) {
    super("GIT_TIMEOUT", "Odczyt statusu Git przekroczył bezpieczny limit czasu.", true, options);
    this.name = "GitTimeoutError";
  }
}

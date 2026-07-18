export class CommandRunnerError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly recoverable = true,
    public readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommandRunnerError";
  }
}

function errorType(name: string, code: string, message: string, recoverable = true) {
  return class extends CommandRunnerError {
    public constructor(
      customMessage = message,
      details?: Readonly<Record<string, unknown>>,
      options?: ErrorOptions,
    ) {
      super(code, customMessage, recoverable, details, options);
      this.name = name;
    }
  };
}

export const CommandExecutionDisabledError = errorType(
  "CommandExecutionDisabledError",
  "COMMAND_EXECUTION_DISABLED",
  "Wykonywanie poleceń jest wyłączone.",
);
export const CommandNotFoundError = errorType(
  "CommandNotFoundError",
  "COMMAND_NOT_FOUND",
  "Program lub wykryte polecenie nie istnieje.",
);
export const CommandNotAllowedError = errorType(
  "CommandNotAllowedError",
  "COMMAND_NOT_ALLOWED",
  "Polecenie nie jest dozwolone.",
);
export const CommandPolicyViolationError = errorType(
  "CommandPolicyViolationError",
  "COMMAND_POLICY_VIOLATION",
  "Polecenie zostało zablokowane przez politykę bezpieczeństwa.",
);
export const CommandConfirmationRequiredError = errorType(
  "CommandConfirmationRequiredError",
  "COMMAND_CONFIRMATION_REQUIRED",
  "Polecenie wymaga potwierdzenia użytkownika.",
);
export const CommandLimitExceededError = errorType(
  "CommandLimitExceededError",
  "COMMAND_LIMIT_EXCEEDED",
  "Przekroczono limit poleceń sesji.",
);
export const CommandTimeoutError = errorType(
  "CommandTimeoutError",
  "COMMAND_TIMEOUT",
  "Polecenie przekroczyło limit czasu.",
);
export const CommandAbortedError = errorType(
  "CommandAbortedError",
  "COMMAND_ABORTED",
  "Polecenie zostało przerwane.",
);
export const CommandSpawnError = errorType(
  "CommandSpawnError",
  "COMMAND_SPAWN_ERROR",
  "Nie udało się uruchomić procesu.",
);
export const CommandOutputLimitError = errorType(
  "CommandOutputLimitError",
  "COMMAND_OUTPUT_LIMIT",
  "Wyjście polecenia przekroczyło limit.",
);
export const WorkingDirectoryError = errorType(
  "WorkingDirectoryError",
  "WORKING_DIRECTORY_INVALID",
  "Katalog roboczy polecenia jest niedozwolony.",
);
export const UnsafeShellExpressionError = errorType(
  "UnsafeShellExpressionError",
  "UNSAFE_SHELL_EXPRESSION",
  "Wykryto niedozwolone wyrażenie powłoki.",
);
export const NetworkAccessBlockedError = errorType(
  "NetworkAccessBlockedError",
  "NETWORK_ACCESS_BLOCKED",
  "Dostęp do sieci jest zablokowany.",
);
export const PackageInstallBlockedError = errorType(
  "PackageInstallBlockedError",
  "PACKAGE_INSTALL_BLOCKED",
  "Instalowanie pakietów jest zablokowane.",
);
export const EnvironmentVariableBlockedError = errorType(
  "EnvironmentVariableBlockedError",
  "ENVIRONMENT_VARIABLE_BLOCKED",
  "Niedozwolona zmienna środowiskowa została zablokowana.",
);
export const ProcessTreeTerminationError = errorType(
  "ProcessTreeTerminationError",
  "PROCESS_TREE_TERMINATION_FAILED",
  "Nie udało się zakończyć drzewa procesów.",
  false,
);
export const UnsupportedProjectCommandError = errorType(
  "UnsupportedProjectCommandError",
  "UNSUPPORTED_PROJECT_COMMAND",
  "Projekt nie udostępnia żądanego bezpiecznego polecenia.",
);
export const AmbiguousPackageManagerError = errorType(
  "AmbiguousPackageManagerError",
  "AMBIGUOUS_PACKAGE_MANAGER",
  "Wykryto sprzeczne informacje o menedżerze pakietów.",
);

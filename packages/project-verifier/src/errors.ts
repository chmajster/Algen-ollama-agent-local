export class ProjectVerifierError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly recoverable = true,
    public readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectVerifierError";
  }
}

function errorType(name: string, code: string, message: string, recoverable = true) {
  return class extends ProjectVerifierError {
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

export const VerificationUnavailableError = errorType(
  "VerificationUnavailableError",
  "VERIFICATION_UNAVAILABLE",
  "Projekt nie udostępnia bezpiecznych poleceń weryfikacyjnych.",
);
export const VerificationFailedError = errorType(
  "VerificationFailedError",
  "VERIFICATION_FAILED",
  "Weryfikacja projektu nie powiodła się.",
);
export const BaselineInvalidError = errorType(
  "BaselineInvalidError",
  "BASELINE_INVALID",
  "Baseline nie odpowiada aktualnemu stanowi workspace.",
);
export const RepairAttemptLimitError = errorType(
  "RepairAttemptLimitError",
  "REPAIR_ATTEMPT_LIMIT",
  "Przekroczono limit prób naprawy.",
);

const SECRET = /\b(?:gh[opurs]_|github_pat_|bearer\s+|password=|token=)[^\s]+/gi;

export class OrchestrationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly remediation: string,
    options?: ErrorOptions,
  ) {
    super(message.replace(SECRET, "[REDACTED]"), options);
    this.name = new.target.name;
  }
}

type Constructor = new (message?: string, options?: ErrorOptions) => OrchestrationError;
function define(code: string, remediation: string): Constructor {
  return class extends OrchestrationError {
    public constructor(message = code.replaceAll("_", " ").toLowerCase(), options?: ErrorOptions) {
      super(code, message, remediation, options);
      this.name = `${code
        .toLowerCase()
        .split("_")
        .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
        .join("")}Error`;
    }
  };
}

export const OrchestrationDisabledError = define(
  "ORCHESTRATION_DISABLED",
  "Włącz orkiestrację w konfiguracji użytkownika.",
);
export const OrchestrationSessionNotFoundError = define(
  "ORCHESTRATION_SESSION_NOT_FOUND",
  "Wybierz istniejącą sesję.",
);
export const OrchestrationSessionStateError = define(
  "ORCHESTRATION_SESSION_STATE",
  "Wykonaj operację dozwoloną w bieżącym stanie.",
);
export const OrchestrationPlanInvalidError = define(
  "ORCHESTRATION_PLAN_INVALID",
  "Popraw plan i zwaliduj DAG.",
);
export const OrchestrationPlanApprovalRequiredError = define(
  "ORCHESTRATION_PLAN_APPROVAL_REQUIRED",
  "Użytkownik musi zatwierdzić plan.",
);
export const OrchestrationFinalApprovalRequiredError = define(
  "ORCHESTRATION_FINAL_APPROVAL_REQUIRED",
  "Użytkownik musi zatwierdzić końcowy wynik.",
);
export const TaskGraphInvalidError = define("TASK_GRAPH_INVALID", "Popraw graf zadań.");
export const TaskGraphCycleError = define("TASK_GRAPH_CYCLE", "Usuń cykliczną zależność.");
export const TaskGraphDependencyError = define(
  "TASK_GRAPH_DEPENDENCY",
  "Popraw brakującą zależność.",
);
export const TaskGraphLimitError = define("TASK_GRAPH_LIMIT", "Zmniejsz graf.");
export const TaskGraphDeadlockError = define(
  "TASK_GRAPH_DEADLOCK",
  "Przejrzyj zależności i lease’y.",
);
export const SpecialistNotFoundError = define(
  "SPECIALIST_NOT_FOUND",
  "Użyj roli z centralnego rejestru.",
);
export const SpecialistModelUnavailableError = define(
  "SPECIALIST_MODEL_UNAVAILABLE",
  "Użyj skonfigurowanego modelu domyślnego.",
);
export const SpecialistAccessDeniedError = define(
  "SPECIALIST_ACCESS_DENIED",
  "Użyj wyłącznie narzędzi dozwolonych dla roli.",
);
export const SpecialistTaskFailedError = define(
  "SPECIALIST_TASK_FAILED",
  "Przejrzyj dowody i zdecyduj o replanie.",
);
export const SpecialistTaskTimeoutError = define(
  "SPECIALIST_TASK_TIMEOUT",
  "Ponów przejściowy błąd w limicie retry.",
);
export const SpecialistResultInvalidError = define(
  "SPECIALIST_RESULT_INVALID",
  "Zwróć ustrukturyzowany wynik z dowodami.",
);
export const SpecialistRetryLimitError = define(
  "SPECIALIST_RETRY_LIMIT",
  "Przejdź do replanu lub decyzji użytkownika.",
);
export const AgentCreationLimitError = define(
  "AGENT_CREATION_LIMIT",
  "Zmniejsz liczbę specjalistów.",
);
export const AgentDepthLimitError = define("AGENT_DEPTH_LIMIT", "Nie twórz dalszych podzadań.");
export const AgentParallelLimitError = define(
  "AGENT_PARALLEL_LIMIT",
  "Poczekaj na zwolnienie slotu.",
);
export const OrchestrationBudgetExceededError = define(
  "ORCHESTRATION_BUDGET_EXCEEDED",
  "Zakończ sesję lub zatwierdź mniejszy zakres.",
);
export const ArtifactSchemaError = define("ARTIFACT_SCHEMA", "Zwróć artefakt zgodny ze schematem.");
export const ArtifactNotFoundError = define(
  "ARTIFACT_NOT_FOUND",
  "Sprawdź wymagane wejścia zadania.",
);
export const ArtifactVersionError = define("ARTIFACT_VERSION", "Użyj aktualnej wersji artefaktu.");
export const ArtifactSizeLimitError = define(
  "ARTIFACT_SIZE_LIMIT",
  "Zmniejsz artefakt do minimalnych dowodów.",
);
export const FileLeaseConflictError = define(
  "FILE_LEASE_CONFLICT",
  "Poczekaj na zwolnienie konfliktującej ścieżki.",
);
export const FileLeaseTimeoutError = define(
  "FILE_LEASE_TIMEOUT",
  "Zwolnij wygasły lease i ponów harmonogram.",
);
export const FileLeaseDeadlockError = define(
  "FILE_LEASE_DEADLOCK",
  "Pozyskuj lease’y w deterministycznej kolejności.",
);
export const ChangeSetMergeConflictError = define(
  "CHANGESET_MERGE_CONFLICT",
  "Przekaż konflikt do replanu lub użytkownika.",
);
export const AgentConsensusError = define(
  "AGENT_CONSENSUS",
  "Zbierz brakujące dowody lub poproś użytkownika.",
);
export const AgentConflictUnresolvedError = define(
  "AGENT_CONFLICT_UNRESOLVED",
  "Rozwiąż konflikt przed końcowym zatwierdzeniem.",
);
export const IndependentReviewRequiredError = define(
  "INDEPENDENT_REVIEW_REQUIRED",
  "Uruchom niezależny review.",
);
export const IndependentReviewFailedError = define(
  "INDEPENDENT_REVIEW_FAILED",
  "Utwórz poprawkę lub poproś użytkownika.",
);
export const SecurityReviewRequiredError = define(
  "SECURITY_REVIEW_REQUIRED",
  "Uruchom obowiązkowy security review.",
);
export const SecurityReviewBlockedError = define(
  "SECURITY_REVIEW_BLOCKED",
  "Usuń krytyczne ryzyko; blokady nie można pominąć.",
);
export const OrchestrationRecoveryError = define(
  "ORCHESTRATION_RECOVERY",
  "Zweryfikuj manifest i wznów ręcznie.",
);
export const OrchestrationManifestError = define(
  "ORCHESTRATION_MANIFEST",
  "Napraw lub odrzuć uszkodzony manifest.",
);

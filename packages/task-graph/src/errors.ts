export class TaskGraphError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly remediation: string,
    options?: ErrorOptions,
  ) {
    super(message.replace(/(token|password|secret)=[^\s]+/gi, "$1=[REDACTED]"), options);
    this.name = new.target.name;
  }
}

export class TaskGraphInvalidError extends TaskGraphError {
  public constructor(message = "Graf zadań jest niepoprawny.", options?: ErrorOptions) {
    super("TASK_GRAPH_INVALID", message, "Popraw strukturę planu i zwaliduj ją ponownie.", options);
  }
}

export class TaskGraphCycleError extends TaskGraphError {
  public constructor(message = "Graf zadań zawiera cykl.", options?: ErrorOptions) {
    super("TASK_GRAPH_CYCLE", message, "Usuń cykliczną zależność.", options);
  }
}

export class TaskGraphDependencyError extends TaskGraphError {
  public constructor(message = "Graf zawiera nieistniejącą zależność.", options?: ErrorOptions) {
    super("TASK_GRAPH_DEPENDENCY", message, "Dodaj brakujący węzeł albo usuń zależność.", options);
  }
}

export class TaskGraphLimitError extends TaskGraphError {
  public constructor(message = "Graf przekracza skonfigurowany limit.", options?: ErrorOptions) {
    super("TASK_GRAPH_LIMIT", message, "Zmniejsz liczbę lub głębokość podzadań.", options);
  }
}

export class TaskGraphDeadlockError extends TaskGraphError {
  public constructor(
    message = "Graf nie ma zadań możliwych do uruchomienia.",
    options?: ErrorOptions,
  ) {
    super("TASK_GRAPH_DEADLOCK", message, "Sprawdź zależności i stany węzłów.", options);
  }
}

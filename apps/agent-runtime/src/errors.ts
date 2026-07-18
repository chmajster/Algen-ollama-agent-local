import type { ZodIssue } from "zod";

export class ConfigurationError extends Error {
  public readonly issues: readonly ZodIssue[];

  public constructor(message: string, issues: readonly ZodIssue[] = []) {
    super(message);
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

export class OllamaConnectionError extends Error {
  public constructor(host: string, options?: ErrorOptions) {
    super(
      `Nie można połączyć się z Ollamą pod adresem ${host}.\nUruchom usługę Ollama i ponów próbę.`,
      options,
    );
    this.name = "OllamaConnectionError";
  }
}

export class ModelNotFoundError extends Error {
  public constructor(model: string, options?: ErrorOptions) {
    super(
      `Model ${model} nie jest dostępny lokalnie.\nPobierz go poleceniem:\nollama pull ${model}`,
      options,
    );
    this.name = "ModelNotFoundError";
  }
}

export class OllamaRequestError extends Error {
  public constructor(details: string, options?: ErrorOptions) {
    super(`Ollama nie mogła przetworzyć żądania: ${details}`, options);
    this.name = "OllamaRequestError";
  }
}

export class AgentMaxStepsError extends Error {
  public constructor(maxSteps: number) {
    super(`Agent osiągnął limit ${maxSteps} kroków bez uzyskania końcowej odpowiedzi.`);
    this.name = "AgentMaxStepsError";
  }
}

export class RepeatedToolCallError extends Error {
  public constructor(toolName: string) {
    super(`Wykryto powtarzające się identyczne wywołanie narzędzia: ${toolName}.`);
    this.name = "RepeatedToolCallError";
  }
}

export class ToolValidationError extends Error {
  public constructor(
    public readonly toolName: string,
    details: string,
    options?: ErrorOptions,
  ) {
    super(`Nieprawidłowe argumenty narzędzia ${toolName}: ${details}`, options);
    this.name = "ToolValidationError";
  }
}

export class ToolExecutionError extends Error {
  public constructor(
    public readonly toolName: string,
    details: string,
    options?: ErrorOptions,
  ) {
    super(`Narzędzie ${toolName} nie mogło zostać wykonane: ${details}`, options);
    this.name = "ToolExecutionError";
  }
}

export class UnknownToolError extends Error {
  public constructor(public readonly toolName: string) {
    super(`Model poprosił o nieznane narzędzie: ${toolName}.`);
    this.name = "UnknownToolError";
  }
}

export class CiAnalysisPackageError extends Error {
  public readonly code = "CI_ANALYSIS_ERROR";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CiAnalysisPackageError";
  }
}

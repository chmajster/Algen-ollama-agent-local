import type { VerificationResult } from "./verifierTypes.js";

export function verificationReport(result: VerificationResult): string {
  const lines = [
    `Weryfikacja: ${result.status}`,
    `Kroki: ${result.steps.length}`,
    `Sukces: ${result.summary.passed}`,
    `Błędy: ${result.summary.failed}`,
    `Pominięte/niedostępne: ${result.summary.skipped + result.summary.unavailable}`,
    `Nowe regresje: ${result.regressions.length}`,
    `Błędy istniejące wcześniej: ${result.preExistingIssues.length}`,
    `Czas: ${result.durationMs} ms`,
  ];
  for (const step of result.steps)
    lines.push(
      `- ${step.displayName}: ${step.status} (kod ${step.exitCode ?? "brak"}, ${step.durationMs} ms)`,
    );
  return lines.join("\n");
}

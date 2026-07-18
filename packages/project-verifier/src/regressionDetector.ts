import type {
  RegressionComparison,
  VerificationBaseline,
  VerificationDiagnostic,
} from "./verifierTypes.js";

function locationKey(item: VerificationDiagnostic): string {
  return [item.source, item.code ?? "", item.file ?? "", item.line ?? "", item.column ?? ""].join(
    "|",
  );
}

export class RegressionDetector {
  public compare(
    current: readonly VerificationDiagnostic[],
    baseline?: VerificationBaseline,
  ): RegressionComparison {
    if (baseline === undefined) {
      return { regressions: [...current], preExisting: [], resolved: [], changed: [] };
    }
    const oldByFingerprint = new Map(baseline.diagnostics.map((item) => [item.fingerprint, item]));
    const oldByLocation = new Map(baseline.diagnostics.map((item) => [locationKey(item), item]));
    const currentFingerprints = new Set(current.map((item) => item.fingerprint));
    const regressions: VerificationDiagnostic[] = [];
    const preExisting: VerificationDiagnostic[] = [];
    const changed: VerificationDiagnostic[] = [];
    for (const item of current) {
      if (oldByFingerprint.has(item.fingerprint)) preExisting.push(item);
      else if (oldByLocation.has(locationKey(item))) {
        changed.push(item);
        if (item.severity === "error") regressions.push(item);
      } else regressions.push(item);
    }
    const resolved = baseline.diagnostics.filter(
      (item) =>
        !currentFingerprints.has(item.fingerprint) &&
        !current.some((value) => locationKey(value) === locationKey(item)),
    );
    return { regressions, preExisting, resolved, changed };
  }
}

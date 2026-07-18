import { ciFailureFingerprint } from "./ciFailureFingerprint.js";
import type { CiDiagnostic, CiFailureCategory } from "./ciTypes.js";

const PATTERNS: RegExp[] = [
  /^(?<file>[^\s][^:(]+)\((?<line>\d+),(?<column>\d+)\):\s*(?:error|warning)\s*(?:TS\d+:\s*)?(?<message>.+)$/,
  /^(?<file>[^\s][^:]+):(?<line>\d+):(?<column>\d+)(?:\s+-\s+|:\s*)(?:error\s+)?(?<message>.+)$/,
  /^\s*at\s+(?:.+\s+\()?((?<file>[^():]+):(?<line>\d+):(?<column>\d+))\)?$/,
];

function number(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseCiDiagnostics(log: string, category: CiFailureCategory): CiDiagnostic[] {
  const diagnostics: CiDiagnostic[] = [];
  const seen = new Set<string>();
  for (const line of log.split("\n")) {
    for (const pattern of PATTERNS) {
      const match = pattern.exec(line);
      if (match?.groups === undefined) continue;
      const file = match.groups.file?.trim().replaceAll("\\", "/");
      const message = (match.groups.message ?? line).trim().slice(0, 2_000);
      const lineNumber = number(match.groups.line);
      const column = number(match.groups.column);
      const fingerprint = ciFailureFingerprint({
        category,
        ...(file === undefined ? {} : { file }),
        ...(lineNumber === undefined ? {} : { line: lineNumber }),
        message,
      });
      if (!seen.has(fingerprint)) {
        seen.add(fingerprint);
        diagnostics.push({
          ...(file === undefined ? {} : { file }),
          ...(lineNumber === undefined ? {} : { line: lineNumber }),
          ...(column === undefined ? {} : { column }),
          message,
          fingerprint,
        });
      }
      break;
    }
    if (diagnostics.length >= 100) break;
  }
  return diagnostics;
}

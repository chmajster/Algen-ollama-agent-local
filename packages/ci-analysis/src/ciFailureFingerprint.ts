import { createHash } from "node:crypto";

export function normalizeDiagnosticMessage(value: string): string {
  return value
    .replace(/\b[0-9a-f]{7,40}\b/gi, "<sha>")
    .replace(/\b\d+(?:\.\d+)*\b/g, "<n>")
    .replace(/[A-Z]:\\[^\s:]+|\/(?:[^\s/:]+\/)+[^\s:]+/gi, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function ciFailureFingerprint(input: {
  category?: string;
  file?: string;
  line?: number;
  message: string;
}): string {
  const normalized = [
    input.category ?? "unknown",
    input.file?.replaceAll("\\", "/").toLowerCase() ?? "",
    input.line ?? "",
    normalizeDiagnosticMessage(input.message),
  ].join("|");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

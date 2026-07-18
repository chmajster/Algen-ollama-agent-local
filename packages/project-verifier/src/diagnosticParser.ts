import { createHash } from "node:crypto";

import type { CommandCategory, CommandResult } from "@local-code-agent/command-runner";

import type { VerificationDiagnostic } from "./verifierTypes.js";

function source(category: CommandCategory): VerificationDiagnostic["source"] {
  if (category === "lint") return "lint";
  if (category === "typecheck") return "typecheck";
  if (category === "build") return "build";
  if (category === "format") return "format";
  return "test";
}

function normalizedMessage(message: string): string {
  return message
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/\d+(?:\.\d+)?\s*(?:ms|s)/giu, "<czas>");
}

export function diagnosticFingerprint(value: Omit<VerificationDiagnostic, "fingerprint">): string {
  return createHash("sha256")
    .update(
      [
        value.source,
        value.code ?? "",
        value.file ?? "",
        value.line ?? "",
        value.column ?? "",
        normalizedMessage(value.message),
      ].join("|"),
    )
    .digest("hex");
}

export class DiagnosticParser {
  public parse(category: CommandCategory, result: CommandResult): VerificationDiagnostic[] {
    const diagnostics: VerificationDiagnostic[] = [];
    const text = `${result.stdout}\n${result.stderr}`;
    const patterns = [
      /^(?<file>[^\r\n:(]+\.[\w]+)\((?<line>\d+),(?<column>\d+)\):\s*(?<severity>error|warning)\s*(?<code>[A-Z]*\d+)?:?\s*(?<message>.+)$/gimu,
      /^(?<file>[^\r\n:]+\.[\w]+):(?<line>\d+):(?<column>\d+):\s*(?<severity>error|warning)?\s*(?<code>[\w-]+)?\s*(?<message>.+)$/gimu,
      /^FAILED\s+(?<file>[^\s:]+)(?:::(?<message>.+))?$/gimu,
      /^error(?:\[(?<code>[^\]]+)\])?:\s*(?<message>.+)$/gimu,
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const groups = match.groups ?? {};
        const base: Omit<VerificationDiagnostic, "fingerprint"> = {
          source: source(category),
          severity: groups.severity?.toLowerCase() === "warning" ? "warning" : "error",
          ...(groups.code === undefined ? {} : { code: groups.code }),
          ...(groups.file === undefined ? {} : { file: groups.file.replaceAll("\\", "/") }),
          ...(groups.line === undefined ? {} : { line: Number(groups.line) }),
          ...(groups.column === undefined ? {} : { column: Number(groups.column) }),
          message: normalizedMessage(groups.message ?? match[0]),
        };
        diagnostics.push({ ...base, fingerprint: diagnosticFingerprint(base) });
      }
    }
    if (diagnostics.length === 0 && result.status === "failed") {
      const first =
        text
          .split(/\r?\n/u)
          .find((line) => /error|fail/iu.test(line))
          ?.trim() ?? "Polecenie zakończyło się błędem.";
      const base: Omit<VerificationDiagnostic, "fingerprint"> = {
        source: source(category),
        severity: "error",
        message: normalizedMessage(first),
      };
      diagnostics.push({ ...base, fingerprint: diagnosticFingerprint(base) });
    }
    return [...new Map(diagnostics.map((item) => [item.fingerprint, item])).values()];
  }
}

import type { CiFailureCategory } from "./ciTypes.js";

interface Classification {
  category: CiFailureCategory;
  confidence: "high" | "medium" | "low";
}

const RULES: ReadonlyArray<{ category: CiFailureCategory; pattern: RegExp }> = [
  { category: "cancelled", pattern: /\b(cancelled|canceled by|operation was canceled)\b/i },
  { category: "timeout", pattern: /\b(timed? out|timeout|deadline exceeded)\b/i },
  {
    category: "permission_failure",
    pattern: /\b(permission denied|forbidden|not authorized|insufficient permissions?)\b/i,
  },
  {
    category: "test_failure",
    pattern:
      /\b(?:(?:test suites?|tests?)\b.{0,30}\bfailed|assertionerror|expected .+ (?:to|but)|vitest|jest|pytest)\b/i,
  },
  {
    category: "lint_failure",
    pattern: /\b(eslint|ruff|pylint|golangci-lint|lint(?:ing)? errors?)\b/i,
  },
  {
    category: "typecheck_failure",
    pattern: /\b(typecheck|tsc\b|typescript|TS\d{4}|mypy|type error)\b/i,
  },
  {
    category: "dependency_failure",
    pattern:
      /\b(eresolve|could not resolve dependency|lockfile|npm err|package not found|failed to install)\b/i,
  },
  {
    category: "configuration_failure",
    pattern:
      /\b(invalid (?:config|configuration|yaml)|workflow is not valid|missing configuration)\b/i,
  },
  {
    category: "infrastructure_failure",
    pattern:
      /\b(runner (?:lost|offline)|service unavailable|bad gateway|internal server error|network unreachable|no space left)\b/i,
  },
  {
    category: "environment_failure",
    pattern: /\b(command not found|unsupported platform|missing environment|not installed)\b/i,
  },
  {
    category: "build_failure",
    pattern:
      /\b(build failed|compilation failed|compiler error|linker command failed|webpack|esbuild)\b/i,
  },
];

export function classifyCiFailure(
  checkName: string,
  log: string,
  conclusion?: string,
): Classification {
  const source = `${checkName}\n${log.slice(0, 100_000)}`;
  for (const rule of RULES) {
    if (rule.pattern.test(source)) return { category: rule.category, confidence: "high" };
  }
  if (conclusion === "timed_out") return { category: "timeout", confidence: "high" };
  if (conclusion === "cancelled") return { category: "cancelled", confidence: "high" };
  if (conclusion === "failure") return { category: "unknown", confidence: "low" };
  return { category: "unknown", confidence: "low" };
}

export function reproductionCommands(category: CiFailureCategory): string[] {
  switch (category) {
    case "test_failure":
      return ["npm test"];
    case "lint_failure":
      return ["npm run lint"];
    case "typecheck_failure":
      return ["npm run typecheck"];
    case "build_failure":
      return ["npm run build"];
    case "dependency_failure":
      return ["npm ci"];
    default:
      return [];
  }
}

import type {
  ProjectCommandDetection,
  VerificationInclude,
  VerificationPlan,
  VerificationScope,
} from "./verifierTypes.js";

const CATEGORY: Record<VerificationInclude, string> = {
  tests: "test",
  lint: "lint",
  typecheck: "typecheck",
  build: "build",
  format_check: "format",
};
const ORDER = ["format", "lint", "typecheck", "test", "build"];

export class VerificationPlanBuilder {
  public build(
    detection: ProjectCommandDetection,
    scope: VerificationScope = "affected_packages",
    include: VerificationInclude[] = ["tests", "lint", "typecheck", "build"],
  ): VerificationPlan {
    const wanted = new Set(include.map((item) => CATEGORY[item]));
    const steps = detection.commands
      .filter((command) => command.allowed && wanted.has(command.category))
      .sort(
        (left, right) =>
          ORDER.indexOf(left.category) - ORDER.indexOf(right.category) ||
          left.id.localeCompare(right.id),
      );
    const skipped = include.flatMap((item) =>
      steps.some((step) => step.category === CATEGORY[item])
        ? []
        : [{ include: item, reason: "Brak wykrytego i dozwolonego polecenia." }],
    );
    return { scope, steps, skipped };
  }
}

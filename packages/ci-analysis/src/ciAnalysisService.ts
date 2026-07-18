import { classifyCiFailure, reproductionCommands } from "./ciFailureClassifier.js";
import { parseCiDiagnostics } from "./ciDiagnosticParser.js";
import { sanitizeCiLog } from "./ciLogSanitizer.js";
import type { CiAnalysisInput, CiFailureAnalysis, CiFailureCategory } from "./ciTypes.js";

function recommendation(category: CiFailureCategory): CiFailureAnalysis["recommendedAction"] {
  switch (category) {
    case "test_failure":
    case "lint_failure":
    case "typecheck_failure":
    case "build_failure":
      return "fix_code";
    case "dependency_failure":
    case "configuration_failure":
      return "fix_configuration";
    case "infrastructure_failure":
    case "environment_failure":
    case "permission_failure":
      return "inspect_infrastructure";
    case "timeout":
    case "cancelled":
      return "rerun";
    default:
      return "manual_review";
  }
}

export class CiAnalysisService {
  public analyze(input: CiAnalysisInput): CiFailureAnalysis {
    const sanitized = sanitizeCiLog(input.log, input.maxLogChars);
    const classification = classifyCiFailure(input.checkName, sanitized.content, input.conclusion);
    const diagnostics = parseCiDiagnostics(sanitized.content, classification.category);
    const files = [
      ...new Set(diagnostics.flatMap((item) => (item.file === undefined ? [] : [item.file]))),
    ].slice(0, 50);
    const environmentalDifferences: string[] = [];
    if (/\b(?:node|python|java|rustc|go)\s+v?\d+/i.test(sanitized.content))
      environmentalDifferences.push("Porównaj wersję runtime z lokalnym środowiskiem.");
    if (/\b(?:ubuntu|windows|macos)-latest\b/i.test(sanitized.content))
      environmentalDifferences.push("Sprawdź różnice systemu operacyjnego runnera.");
    return {
      checkId: input.checkId,
      category: classification.category,
      confidence:
        diagnostics.length > 0 && classification.confidence === "low"
          ? "medium"
          : classification.confidence,
      summary: `Check „${input.checkName}” sklasyfikowano jako ${classification.category}.`,
      diagnostics,
      likelyRelatedFiles: files,
      localReproductionCommands: reproductionCommands(classification.category),
      environmentalDifferences,
      recommendedAction: recommendation(classification.category),
    };
  }
}

import { PERFORMANCE_PROMPT } from "./prompts/performancePrompt.js";
import { BaseSpecialistAgent } from "./specialistAgent.js";
import { accessPolicyForRole, capabilitiesForRole } from "./accessPolicies.js";
export class PerformanceAgent extends BaseSpecialistAgent {
  public readonly role = "performance" as const;
  public readonly capabilities = capabilitiesForRole(this.role);
  public readonly access = accessPolicyForRole(this.role);
  public constructor(id: string, runner: ConstructorParameters<typeof BaseSpecialistAgent>[1]) {
    super(id, runner, PERFORMANCE_PROMPT);
  }
}

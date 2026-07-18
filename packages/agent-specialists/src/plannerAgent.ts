import { PLANNER_PROMPT } from "./prompts/plannerPrompt.js";
import { BaseSpecialistAgent } from "./specialistAgent.js";
import { accessPolicyForRole, capabilitiesForRole } from "./accessPolicies.js";
export class PlannerAgent extends BaseSpecialistAgent {
  public readonly role = "planner" as const;
  public readonly capabilities = capabilitiesForRole(this.role);
  public readonly access = accessPolicyForRole(this.role);
  public constructor(id: string, runner: ConstructorParameters<typeof BaseSpecialistAgent>[1]) {
    super(id, runner, PLANNER_PROMPT);
  }
}

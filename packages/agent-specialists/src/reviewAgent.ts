import { REVIEW_PROMPT } from "./prompts/reviewPrompt.js";
import { BaseSpecialistAgent } from "./specialistAgent.js";
import { accessPolicyForRole, capabilitiesForRole } from "./accessPolicies.js";
export class ReviewAgent extends BaseSpecialistAgent {
  public readonly role = "review" as const;
  public readonly capabilities = capabilitiesForRole(this.role);
  public readonly access = accessPolicyForRole(this.role);
  public constructor(id: string, runner: ConstructorParameters<typeof BaseSpecialistAgent>[1]) {
    super(id, runner, REVIEW_PROMPT);
  }
}

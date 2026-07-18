import { IMPLEMENTATION_PROMPT } from "./prompts/implementationPrompt.js";
import { BaseSpecialistAgent } from "./specialistAgent.js";
import { accessPolicyForRole, capabilitiesForRole } from "./accessPolicies.js";
export class ImplementationAgent extends BaseSpecialistAgent {
  public readonly role = "implementation" as const;
  public readonly capabilities = capabilitiesForRole(this.role);
  public readonly access = accessPolicyForRole(this.role);
  public constructor(id: string, runner: ConstructorParameters<typeof BaseSpecialistAgent>[1]) {
    super(id, runner, IMPLEMENTATION_PROMPT);
  }
}

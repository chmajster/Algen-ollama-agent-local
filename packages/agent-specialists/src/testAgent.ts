import { TEST_PROMPT } from "./prompts/testPrompt.js";
import { BaseSpecialistAgent } from "./specialistAgent.js";
import { accessPolicyForRole, capabilitiesForRole } from "./accessPolicies.js";
export class TestAgent extends BaseSpecialistAgent {
  public readonly role = "test" as const;
  public readonly capabilities = capabilitiesForRole(this.role);
  public readonly access = accessPolicyForRole(this.role);
  public constructor(id: string, runner: ConstructorParameters<typeof BaseSpecialistAgent>[1]) {
    super(id, runner, TEST_PROMPT);
  }
}

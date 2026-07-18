import { REPOSITORY_EXPLORER_PROMPT } from "./prompts/repositoryExplorerPrompt.js";
import { BaseSpecialistAgent } from "./specialistAgent.js";
import { accessPolicyForRole, capabilitiesForRole } from "./accessPolicies.js";
export class RepositoryExplorerAgent extends BaseSpecialistAgent {
  public readonly role = "repository_explorer" as const;
  public readonly capabilities = capabilitiesForRole(this.role);
  public readonly access = accessPolicyForRole(this.role);
  public constructor(id: string, runner: ConstructorParameters<typeof BaseSpecialistAgent>[1]) {
    super(id, runner, REPOSITORY_EXPLORER_PROMPT);
  }
}

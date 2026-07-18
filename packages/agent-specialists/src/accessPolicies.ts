import type { AgentCapability, SpecialistAccessPolicy, SpecialistRole } from "./specialistTypes.js";

const READ_ONLY: SpecialistAccessPolicy = {
  repositoryRead: true,
  semanticSearch: true,
  lspRead: true,
  prepareChanges: false,
  applyChanges: false,
  runVerification: false,
  executeCommands: false,
  useMcp: false,
  remoteRead: false,
  remoteWrite: false,
};

export function accessPolicyForRole(role: SpecialistRole): SpecialistAccessPolicy {
  switch (role) {
    case "implementation":
      return { ...READ_ONLY, prepareChanges: true };
    case "test":
      return {
        ...READ_ONLY,
        prepareChanges: true,
        runVerification: true,
        executeCommands: true,
        allowedFilePatterns: ["**/*.test.*", "**/*.spec.*", "tests/**", "test/**"],
      };
    case "documentation":
      return {
        ...READ_ONLY,
        prepareChanges: true,
        allowedFilePatterns: ["**/*.md", "docs/**", "CHANGELOG*"],
      };
    case "repository_explorer":
      return { ...READ_ONLY, useMcp: true };
    default:
      return { ...READ_ONLY };
  }
}

export function capabilitiesForRole(role: SpecialistRole): AgentCapability[] {
  const access = accessPolicyForRole(role);
  const result: AgentCapability[] = [];
  if (access.repositoryRead) result.push("repository_read");
  if (access.semanticSearch) result.push("semantic_search");
  if (access.lspRead) result.push("lsp_read");
  if (access.prepareChanges) result.push("prepare_changes");
  if (access.runVerification) result.push("verification");
  if (access.executeCommands) result.push("command_execution");
  if (access.useMcp) result.push("mcp_read");
  if (role === "architecture") result.push("architecture_analysis");
  if (role === "security") result.push("security_analysis");
  if (role === "review") result.push("review");
  if (role === "documentation") result.push("documentation");
  return result;
}

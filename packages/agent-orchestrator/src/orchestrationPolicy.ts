import type { SpecialistAccessPolicy, SpecialistRole } from "@local-code-agent/agent-specialists";

import { SpecialistAccessDeniedError } from "./errors.js";

const TOOL_PERMISSIONS: Record<string, keyof SpecialistAccessPolicy> = {
  read_file: "repositoryRead",
  search_repository: "repositoryRead",
  get_change_preview: "repositoryRead",
  semantic_search: "semanticSearch",
  lsp_symbols: "lspRead",
  prepare_patch: "prepareChanges",
  prepare_create_file: "prepareChanges",
  prepare_delete_file: "prepareChanges",
  prepare_move_file: "prepareChanges",
  run_verification: "runVerification",
  run_project_command: "executeCommands",
  mcp_read: "useMcp",
  remote_read: "remoteRead",
};

const ABSOLUTELY_FORBIDDEN = new Set([
  "apply_changes",
  "restore_checkpoint",
  "remote_write",
  "publish_branch",
  "create_pull_request",
  "create_agent",
  "create_orchestration_session",
]);

export class OrchestrationPolicy {
  public assertToolAllowed(
    role: SpecialistRole,
    access: SpecialistAccessPolicy,
    toolName: string,
  ): void {
    if (access.applyChanges !== false || access.remoteWrite !== false) {
      throw new SpecialistAccessDeniedError(`Rola ${role} ma niepoprawną politykę centralną.`);
    }
    if (ABSOLUTELY_FORBIDDEN.has(toolName)) {
      throw new SpecialistAccessDeniedError(`Specjalista ${role} nie może użyć ${toolName}.`);
    }
    const permission = TOOL_PERMISSIONS[toolName];
    if (permission === undefined || access[permission] !== true) {
      throw new SpecialistAccessDeniedError(
        `Narzędzie ${toolName} nie jest dozwolone dla roli ${role}.`,
      );
    }
  }
}

import {
  RemoteForcePushBlockedError,
  RemotePermissionDeniedError,
  RemoteRepositoryUnverifiedError,
} from "./errors.js";
import type { RepositoryPermissions, RepositoryTrustState } from "./remoteRepositoryTypes.js";

export type RemotePolicyAction =
  | "read_repository"
  | "read_checks"
  | "read_logs"
  | "read_reviews"
  | "publish_branch"
  | "create_pull_request"
  | "update_pull_request"
  | "reply_review"
  | "resolve_thread"
  | "force_push"
  | "merge_pull_request"
  | "delete_remote_branch";

export interface RemotePolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

const FORBIDDEN = new Set<RemotePolicyAction>([
  "force_push",
  "merge_pull_request",
  "delete_remote_branch",
]);
const READ_ONLY = new Set<RemotePolicyAction>([
  "read_repository",
  "read_checks",
  "read_logs",
  "read_reviews",
]);

export class RemoteOperationPolicy {
  public evaluate(input: {
    action: RemotePolicyAction;
    trust: RepositoryTrustState;
    permissions: RepositoryPermissions;
  }): RemotePolicyDecision {
    if (FORBIDDEN.has(input.action)) {
      if (input.action === "force_push") throw new RemoteForcePushBlockedError();
      return {
        allowed: false,
        requiresApproval: false,
        reason: "Operacja jest bezwzględnie zablokowana.",
      };
    }
    if (input.trust !== "verified_for_session" && input.trust !== "verified_for_workspace") {
      throw new RemoteRepositoryUnverifiedError();
    }
    const permitted = this.hasPermission(input.action, input.permissions);
    if (!permitted)
      throw new RemotePermissionDeniedError(`Brak uprawnienia dla operacji ${input.action}.`);
    return {
      allowed: true,
      requiresApproval: !READ_ONLY.has(input.action),
      reason: READ_ONLY.has(input.action)
        ? "Zweryfikowany odczyt."
        : "Zapis wymaga jednorazowej zgody użytkownika.",
    };
  }

  private hasPermission(action: RemotePolicyAction, permissions: RepositoryPermissions): boolean {
    switch (action) {
      case "read_repository":
      case "read_checks":
      case "read_logs":
      case "read_reviews":
        return permissions.read;
      case "publish_branch":
        return permissions.canPush;
      case "create_pull_request":
        return permissions.canCreatePullRequest;
      case "update_pull_request":
        return permissions.write;
      case "reply_review":
        return permissions.canComment;
      case "resolve_thread":
        return permissions.canResolveReviewThreads;
      default:
        return false;
    }
  }
}

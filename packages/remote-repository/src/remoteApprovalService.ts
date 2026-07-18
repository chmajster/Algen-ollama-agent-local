import { randomUUID } from "node:crypto";

import { RemotePushApprovalRequiredError } from "./errors.js";
import type { RemotePolicyAction } from "./remoteOperationPolicy.js";

export interface RemoteApprovalRequest {
  id: string;
  action: RemotePolicyAction;
  repository: string;
  summary: string;
  taskId?: string;
  createdAt: string;
  status: "pending" | "approved" | "denied" | "consumed";
}

export class RemoteApprovalService {
  private readonly requests = new Map<string, RemoteApprovalRequest>();

  public request(
    input: Omit<RemoteApprovalRequest, "id" | "createdAt" | "status">,
  ): RemoteApprovalRequest {
    const request: RemoteApprovalRequest = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    this.requests.set(request.id, request);
    return { ...request };
  }

  public decide(
    id: string,
    decision: "approved" | "denied",
    actor: "user_cli" | "user_ui",
  ): RemoteApprovalRequest {
    void actor;
    const request = this.requests.get(id);
    if (request === undefined || request.status !== "pending") {
      throw new RemotePushApprovalRequiredError(
        "Żądanie zgody nie istnieje albo zostało już użyte.",
      );
    }
    request.status = decision;
    return { ...request };
  }

  public consume(id: string, expectedAction: RemotePolicyAction, repository: string): void {
    const request = this.requests.get(id);
    if (
      request === undefined ||
      request.status !== "approved" ||
      request.action !== expectedAction ||
      request.repository.toLowerCase() !== repository.toLowerCase()
    ) {
      throw new RemotePushApprovalRequiredError("Brak ważnej jednorazowej zgody dla tej operacji.");
    }
    request.status = "consumed";
  }

  public get(id: string): RemoteApprovalRequest | undefined {
    const request = this.requests.get(id);
    return request === undefined ? undefined : { ...request };
  }
}

import type {
  AgentMode,
  EditorContext,
  ProcedureName,
  RuntimeSettings,
  WorkspaceInfo,
  responsePayloadSchemas,
} from "@local-code-agent/runtime-protocol";
import type { z } from "zod";

import type { RuntimeTransport } from "./runtimeTransport.js";

type ResponsePayload<M extends ProcedureName> = z.output<(typeof responsePayloadSchemas)[M]>;

export class RuntimeClient {
  public constructor(private readonly transport: RuntimeTransport) {}

  public call<M extends ProcedureName>(
    method: M,
    payload: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ResponsePayload<M>> {
    return this.transport.request(method, payload, options);
  }

  public initialize(clientVersion: string, workspaceTrusted: boolean) {
    return this.call("runtime.initialize", {
      clientName: "Local Code Agent for VS Code",
      clientVersion,
      workspaceTrusted,
    });
  }

  public setWorkspace(workspace: WorkspaceInfo) {
    return this.call("workspace.set", workspace);
  }

  public updateSettings(settings: RuntimeSettings) {
    return this.call("settings.update", settings);
  }

  public startTask(task: string, mode: AgentMode, context?: EditorContext) {
    return this.call("task.start", { task, mode, ...(context === undefined ? {} : { context }) });
  }
}

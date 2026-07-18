import { randomUUID } from "node:crypto";

import { ArtifactSizeLimitError, SpecialistAccessDeniedError } from "./errors.js";
import type { AgentMessage } from "./orchestrationTypes.js";

const ALLOWED_KEYS = new Set([
  "artifactId",
  "question",
  "answer",
  "dependencyId",
  "conflictId",
  "reason",
]);

export class AgentMessageBus {
  private readonly messages: AgentMessage[] = [];

  public constructor(
    private readonly sessionId: string,
    private readonly taskIds: ReadonlySet<string>,
    private readonly maxBytes: number,
  ) {}

  public publish(input: Omit<AgentMessage, "id" | "sessionId" | "createdAt">): AgentMessage {
    if (!this.taskIds.has(input.fromTaskId) || !this.taskIds.has(input.toTaskId)) {
      throw new SpecialistAccessDeniedError("Wiadomość wskazuje zadanie spoza grafu.");
    }
    if (
      typeof input.payload !== "object" ||
      input.payload === null ||
      Array.isArray(input.payload)
    ) {
      throw new SpecialistAccessDeniedError("Wiadomość musi mieć mały, ustrukturyzowany payload.");
    }
    const payload = input.payload as Record<string, unknown>;
    if (Object.keys(payload).some((key) => !ALLOWED_KEYS.has(key))) {
      throw new SpecialistAccessDeniedError(
        "Message Bus nie przenosi swobodnego chatu ani chain-of-thought.",
      );
    }
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > this.maxBytes) {
      throw new ArtifactSizeLimitError("Wiadomość przekracza limit rozmiaru.");
    }
    const message: AgentMessage = {
      ...input,
      id: randomUUID(),
      sessionId: this.sessionId,
      payload: structuredClone(payload),
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    return structuredClone(message);
  }

  public forTask(taskId: string): AgentMessage[] {
    if (!this.taskIds.has(taskId)) throw new SpecialistAccessDeniedError();
    return this.messages
      .filter((message) => message.toTaskId === taskId)
      .map((message) => structuredClone(message));
  }
}

import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import {
  assertSession,
  createRequest,
  parseNotification,
  parseResponse,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcNotification,
  type ProcedureName,
  type responsePayloadSchemas,
} from "@local-code-agent/runtime-protocol";
import type { z } from "zod";

import { EventEmitter } from "../core/eventEmitter.js";
import type { RuntimeProcess } from "./processLauncher.js";

type ResponsePayload<M extends ProcedureName> = z.output<(typeof responsePayloadSchemas)[M]>;

interface PendingRequest {
  method: ProcedureName;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
  abortCleanup?: () => void;
}

export class RuntimeRpcError extends Error {
  public constructor(
    message: string,
    public readonly rpcCode: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RuntimeRpcError";
  }
}

export interface RuntimeTransportOptions {
  process: RuntimeProcess;
  sessionId: string;
  defaultTimeoutMs?: number;
}

export class RuntimeTransport {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notifications = new EventEmitter<JsonRpcNotification>();
  private readonly protocolErrors = new EventEmitter<Error>();
  private readonly lines: ReadlineInterface;
  private disposed = false;

  public readonly onNotification = this.notifications.event;
  public readonly onProtocolError = this.protocolErrors.event;

  public constructor(private readonly options: RuntimeTransportOptions) {
    this.lines = createInterface({ input: options.process.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    this.lines.on("close", () =>
      this.rejectAll(new RuntimeRpcError("Transport runtime został zamknięty.", -32_000)),
    );
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    try {
      const raw = JSON.parse(line) as unknown;
      if (typeof raw === "object" && raw !== null && "id" in raw) {
        const id = (raw as { id?: unknown }).id;
        if (typeof id !== "string" && typeof id !== "number")
          throw new Error("Odpowiedź JSON-RPC nie ma poprawnego id.");
        const pending = this.pending.get(id);
        if (pending === undefined) throw new Error(`Odpowiedź dla nieznanego żądania ${id}.`);
        const response = parseResponse(pending.method, raw);
        this.finishPending(id, pending);
        if ("error" in response) pending.reject(this.rpcError(response));
        else {
          assertSession(this.options.sessionId, response.result.sessionId);
          pending.resolve(response.result.payload);
        }
        return;
      }
      const notification = parseNotification(raw);
      assertSession(this.options.sessionId, notification.params.sessionId);
      this.notifications.fire(notification);
    } catch (error: unknown) {
      this.protocolErrors.fire(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rpcError(response: JsonRpcErrorResponse): RuntimeRpcError {
    return new RuntimeRpcError(response.error.message, response.error.code, response.error.data);
  }

  private finishPending(id: JsonRpcId, pending: PendingRequest): void {
    clearTimeout(pending.timeout);
    pending.abortCleanup?.();
    this.pending.delete(id);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.finishPending(id, pending);
      pending.reject(error);
    }
  }

  public request<M extends ProcedureName>(
    method: M,
    payload: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ResponsePayload<M>> {
    if (this.disposed)
      return Promise.reject(new RuntimeRpcError("Transport runtime jest zamknięty.", -32_000));
    const id = this.nextId++;
    const message = createRequest(id, method, this.options.sessionId, payload as never);
    return new Promise<ResponsePayload<M>>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs ?? 120_000;
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.finishPending(id, pending);
        reject(new RuntimeRpcError(`Przekroczono limit czasu procedury ${method}.`, -32_001));
      }, timeoutMs);
      const pending: PendingRequest = {
        method,
        resolve: (value) => resolve(value as ResponsePayload<M>),
        reject,
        timeout,
      };
      if (options.signal !== undefined) {
        const abort = (): void => {
          if (!this.pending.has(id)) return;
          this.finishPending(id, pending);
          reject(new DOMException("Żądanie runtime zostało anulowane.", "AbortError"));
        };
        options.signal.addEventListener("abort", abort, { once: true });
        pending.abortCleanup = () => options.signal?.removeEventListener("abort", abort);
      }
      this.pending.set(id, pending);
      if (options.signal?.aborted === true) {
        pending.abortCleanup?.();
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new DOMException("Żądanie runtime zostało anulowane.", "AbortError"));
        return;
      }
      this.options.process.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lines.close();
    this.rejectAll(new RuntimeRpcError("Transport runtime został zamknięty.", -32_000));
    this.notifications.dispose();
    this.protocolErrors.dispose();
  }
}

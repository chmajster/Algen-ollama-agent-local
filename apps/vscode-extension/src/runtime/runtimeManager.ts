import { randomUUID } from "node:crypto";

import type {
  JsonRpcNotification,
  ProcedureName,
  RuntimeSettings,
  RuntimeState,
  WorkspaceInfo,
  responsePayloadSchemas,
} from "@local-code-agent/runtime-protocol";
import type { z } from "zod";

import { EventEmitter } from "../core/eventEmitter.js";
import {
  NodeProcessLauncher,
  type ProcessLauncher,
  type RuntimeProcess,
} from "./processLauncher.js";
import { RuntimeClient } from "./runtimeClient.js";
import { RuntimeTransport } from "./runtimeTransport.js";

type ResponsePayload<M extends ProcedureName> = z.output<(typeof responsePayloadSchemas)[M]>;

export interface RuntimeManagerOptions {
  runtimePath: string;
  workspaceDirectory: string;
  extensionVersion: string;
  workspace: WorkspaceInfo;
  settings: RuntimeSettings;
  restartOnCrash: boolean;
  launcher?: ProcessLauncher;
  now?: () => number;
  log?: (level: "error" | "warn" | "info" | "debug", message: string) => void;
}

export class RuntimeManager {
  private state: RuntimeState = "stopped";
  private process: RuntimeProcess | undefined;
  private transport: RuntimeTransport | undefined;
  private client: RuntimeClient | undefined;
  private readonly states = new EventEmitter<RuntimeState>();
  private readonly notifications = new EventEmitter<JsonRpcNotification>();
  private readonly launcher: ProcessLauncher;
  private restartTimes: number[] = [];
  private stopping = false;
  private transactionUncertain = false;
  private exited = true;
  private runtimeInfo: Record<string, unknown> | undefined;

  public readonly onDidChangeState = this.states.event;
  public readonly onNotification = this.notifications.event;

  public constructor(private options: RuntimeManagerOptions) {
    this.launcher = options.launcher ?? new NodeProcessLauncher();
  }

  public getState(): RuntimeState {
    return this.state;
  }

  public getRuntimeInfo(): Record<string, unknown> | undefined {
    return this.runtimeInfo === undefined ? undefined : { ...this.runtimeInfo };
  }

  private setState(state: RuntimeState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.log?.("info", `Stan runtime: ${state}`);
    this.states.fire(state);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    this.transport?.dispose();
    this.transport = undefined;
    this.client = undefined;
    this.process = undefined;
    if (this.stopping) {
      this.setState("stopped");
      return;
    }
    this.options.log?.(
      "warn",
      `Proces runtime zakończył się (code=${String(code)}, signal=${String(signal)}).`,
    );
    if (this.transactionUncertain || !this.options.restartOnCrash) {
      this.setState("failed");
      return;
    }
    const now = (this.options.now ?? Date.now)();
    this.restartTimes = this.restartTimes.filter((time) => now - time <= 5 * 60_000);
    if (this.restartTimes.length >= 3) {
      this.options.log?.("error", "Limit restartów runtime (3/5 min) został osiągnięty.");
      this.setState("failed");
      return;
    }
    this.restartTimes.push(now);
    this.setState("restarting");
    void this.start(true).catch((error: unknown) => {
      this.options.log?.("error", error instanceof Error ? error.message : String(error));
      this.setState("failed");
    });
  }

  public async start(restart = false): Promise<void> {
    if (["starting", "ready", "busy"].includes(this.state)) return;
    this.stopping = false;
    this.transactionUncertain = false;
    this.setState(restart ? "restarting" : "starting");
    const sessionId = randomUUID();
    try {
      const process = this.launcher.launch({
        runtimePath: this.options.runtimePath,
        workspaceDirectory: this.options.workspaceDirectory,
        sessionId,
      });
      this.process = process;
      this.exited = false;
      const transport = new RuntimeTransport({ process, sessionId });
      this.transport = transport;
      this.client = new RuntimeClient(transport);
      transport.onNotification((notification) => {
        if (notification.method === "task.created") this.setState("busy");
        if (["task.completed", "task.failed", "task.cancelled"].includes(notification.method))
          this.setState("ready");
        this.notifications.fire(notification);
      });
      transport.onProtocolError((error) =>
        this.options.log?.("error", `Błąd protokołu: ${error.message}`),
      );
      process.stderr.setEncoding("utf8");
      process.stderr.on("data", (chunk: string | Buffer) => {
        const line = String(chunk).slice(0, 4_000).trim();
        if (line !== "") this.options.log?.("debug", line);
      });
      process.once("exit", (code, signal) => this.handleExit(code, signal));
      this.runtimeInfo = await this.client.initialize(
        this.options.extensionVersion,
        this.options.workspace.trusted,
      );
      await this.client.updateSettings(this.options.settings);
      await this.client.setWorkspace(this.options.workspace);
      this.setState("ready");
    } catch (error: unknown) {
      this.options.log?.("error", error instanceof Error ? error.message : String(error));
      this.process?.kill();
      this.setState("failed");
      throw error;
    }
  }

  public async ensureReady(): Promise<void> {
    if (this.state === "ready" || this.state === "busy") return;
    await this.start();
  }

  public async request<M extends ProcedureName>(
    method: M,
    payload: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal; transaction?: boolean } = {},
  ): Promise<ResponsePayload<M>> {
    await this.ensureReady();
    if (this.client === undefined) throw new Error("Runtime nie jest dostępny.");
    if (options.transaction === true) this.transactionUncertain = true;
    try {
      return await this.client.call(method, payload, options);
    } finally {
      if (options.transaction === true && !this.exited) this.transactionUncertain = false;
    }
  }

  public async update(
    options: Pick<
      RuntimeManagerOptions,
      "settings" | "workspace" | "restartOnCrash" | "workspaceDirectory"
    >,
  ): Promise<void> {
    this.options = { ...this.options, ...options };
    if (this.state === "ready" && this.client !== undefined) {
      await this.client.updateSettings(options.settings);
      await this.client.setWorkspace(options.workspace);
    }
  }

  public async restart(): Promise<void> {
    await this.shutdown();
    this.stopping = false;
    await this.start(true);
  }

  public async shutdown(): Promise<void> {
    if (this.process === undefined) {
      this.setState("stopped");
      return;
    }
    this.stopping = true;
    try {
      if (this.client !== undefined)
        await this.client.call("runtime.shutdown", {}, { timeoutMs: 2_000 });
    } catch {
      // Wymuszone zakończenie poniżej jest ścieżką awaryjną.
    }
    if (!this.exited) this.process?.kill();
    this.transport?.dispose();
    this.process = undefined;
    this.transport = undefined;
    this.client = undefined;
    this.exited = true;
    this.setState("stopped");
  }

  public dispose(): void {
    void this.shutdown();
    this.states.dispose();
    this.notifications.dispose();
  }
}

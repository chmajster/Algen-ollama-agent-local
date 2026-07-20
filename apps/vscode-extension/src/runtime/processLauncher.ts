import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface RuntimeProcess {
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ProcessLaunchOptions {
  runtimePath: string;
  workspaceDirectory: string;
  sessionId: string;
}

export interface ProcessLauncher {
  launch(options: ProcessLaunchOptions): RuntimeProcess;
}

export class NodeProcessLauncher implements ProcessLauncher {
  public launch(options: ProcessLaunchOptions): RuntimeProcess {
    const child = spawn(process.execPath, [options.runtimePath], {
      cwd: options.workspaceDirectory,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        AGENT_RUNTIME_SESSION_ID: options.sessionId,
        NODE_OPTIONS: process.env.ALGEN_NODE_OPTIONS ?? "--max-old-space-size=1024",
        OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL ?? "1",
        OLLAMA_MAX_LOADED_MODELS: process.env.OLLAMA_MAX_LOADED_MODELS ?? "1",
      },
    });
    return child as unknown as RuntimeProcess;
  }
}

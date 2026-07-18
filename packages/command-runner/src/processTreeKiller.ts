import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { ProcessTreeTerminationError } from "./errors.js";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function taskkill(pid: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", reject);
    killer.once("close", () => resolvePromise());
  });
}

export class ProcessTreeKiller {
  public async terminate(child: ChildProcess, graceMs = 250): Promise<void> {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    try {
      if (process.platform === "win32") {
        // Zamknięcie samego wrappera .cmd osierociłoby jego potomków i uniemożliwiło
        // późniejsze odnalezienie drzewa po PID rodzica.
        await taskkill(pid);
        return;
      }
      process.kill(-pid, "SIGTERM");
      await delay(graceMs);
      if (child.exitCode !== null || child.signalCode !== null) return;
      process.kill(-pid, "SIGKILL");
    } catch (error: unknown) {
      const missing =
        typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
      if (!missing) throw new ProcessTreeTerminationError(undefined, { pid }, { cause: error });
    }
  }
}

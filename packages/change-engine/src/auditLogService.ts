import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { SymlinkWriteBlockedError } from "./errors.js";
import type { AuditLogEntry } from "./changeTypes.js";

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export class AuditLogService {
  private readonly agentRoot: string;
  private readonly historyRoot: string;
  private readonly logPath: string;

  public constructor(workspaceRoot: string) {
    this.agentRoot = join(workspaceRoot, ".agent");
    this.historyRoot = join(this.agentRoot, "history");
    this.logPath = join(this.historyRoot, "changes.jsonl");
  }

  private async ensureDirectory(path: string): Promise<void> {
    try {
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new SymlinkWriteBlockedError();
      }
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      await mkdir(path);
    }
  }

  public async append(entry: AuditLogEntry): Promise<void> {
    await this.ensureDirectory(this.agentRoot);
    await this.ensureDirectory(this.historyRoot);
    const handle = await open(this.logPath, "a");
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

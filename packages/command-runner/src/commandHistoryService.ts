import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CommandHistoryEntry } from "./commandTypes.js";
import { WorkingDirectoryError } from "./errors.js";

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function safeArgs(args: readonly string[]): string[] {
  return args.map((arg) =>
    /token|secret|password|credential|api[_-]?key/iu.test(arg) ? "[pominięto]" : arg,
  );
}

function safeReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  return /token|secret|password|credential|api[_-]?key/iu.test(reason) ? "[pominięto]" : reason;
}

export interface CommandHistoryFilter {
  limit?: number;
  category?: string;
  status?: string;
}

export class CommandHistoryService {
  private readonly agentRoot: string;
  private readonly historyRoot: string;
  private readonly logPath: string;

  public constructor(workspaceRoot: string) {
    this.agentRoot = join(workspaceRoot, ".agent");
    this.historyRoot = join(this.agentRoot, "history");
    this.logPath = join(this.historyRoot, "commands.jsonl");
  }

  private async ensureDirectory(path: string): Promise<void> {
    try {
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new WorkingDirectoryError("Katalog historii poleceń jest niedozwolony.");
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      await mkdir(path);
    }
  }

  public async append(entry: CommandHistoryEntry): Promise<void> {
    await this.ensureDirectory(this.agentRoot);
    await this.ensureDirectory(this.historyRoot);
    const handle = await open(this.logPath, "a");
    try {
      await handle.writeFile(
        `${JSON.stringify({
          ...entry,
          args: safeArgs(entry.args),
          ...(entry.reason === undefined ? {} : { reason: safeReason(entry.reason) }),
        })}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  public async list(filter: CommandHistoryFilter = {}): Promise<CommandHistoryEntry[]> {
    let content: string;
    try {
      content = await readFile(this.logPath, "utf8");
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
    const entries: CommandHistoryEntry[] = [];
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as CommandHistoryEntry;
        if (filter.category !== undefined && parsed.category !== filter.category) continue;
        if (
          filter.status !== undefined &&
          parsed.status !== filter.status &&
          parsed.decision !== filter.status
        )
          continue;
        entries.push(parsed);
      } catch {
        // Niepełny ostatni wpis JSONL jest bezpiecznie pomijany.
      }
    }
    return entries.slice(-Math.min(Math.max(filter.limit ?? 20, 1), 200)).reverse();
  }
}

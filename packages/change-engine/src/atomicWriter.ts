import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { AtomicWriteError } from "./errors.js";

export interface AtomicWriterOptions {
  beforeCommit?: (temporaryPath: string, destinationPath: string) => Promise<void>;
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    const missing =
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    if (!missing) throw error;
  }
}

export class AtomicWriter {
  public constructor(private readonly options: AtomicWriterOptions = {}) {}

  private temporaryPath(destinationPath: string): string {
    return join(
      dirname(destinationPath),
      `.${basename(destinationPath)}.agent-tmp-${randomUUID()}`,
    );
  }

  private async writeTemporary(path: string, content: Uint8Array, mode?: number): Promise<void> {
    const handle = await open(path, "wx", mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode !== undefined) await chmod(path, mode & 0o777);
  }

  public async replaceFile(destinationPath: string, content: Uint8Array): Promise<void> {
    const destinationMode = (await stat(destinationPath)).mode;
    const temporaryPath = this.temporaryPath(destinationPath);
    try {
      await this.writeTemporary(temporaryPath, content, destinationMode);
      await this.options.beforeCommit?.(temporaryPath, destinationPath);
      await rename(temporaryPath, destinationPath);
    } catch (error: unknown) {
      try {
        await removeIfPresent(temporaryPath);
      } catch {
        // Pierwotny błąd zapisu jest ważniejszy; plik ma unikalną, rozpoznawalną nazwę tymczasową.
      }
      throw new AtomicWriteError(undefined, undefined, { cause: error });
    }
  }

  public async createFile(destinationPath: string, content: Uint8Array): Promise<void> {
    await mkdir(dirname(destinationPath), { recursive: true });
    const temporaryPath = this.temporaryPath(destinationPath);
    try {
      await this.writeTemporary(temporaryPath, content);
      await this.options.beforeCommit?.(temporaryPath, destinationPath);
      await link(temporaryPath, destinationPath);
      await unlink(temporaryPath);
    } catch (error: unknown) {
      try {
        await removeIfPresent(temporaryPath);
      } catch {
        // Patrz komentarz w replaceFile.
      }
      throw new AtomicWriteError(undefined, undefined, { cause: error });
    }
  }

  public async cleanupTemporaryFiles(directory: string): Promise<number> {
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!/^\..+\.agent-tmp-[0-9a-f-]{36}$/iu.test(entry)) continue;
      await removeIfPresent(join(directory, entry));
      removed += 1;
    }
    return removed;
  }

  public async cleanupWorkspaceTemporaryFiles(workspaceRoot: string): Promise<number> {
    const skippedDirectories = new Set([
      ".git",
      ".agent",
      "node_modules",
      "vendor",
      "dist",
      "build",
      "coverage",
      ".next",
      ".nuxt",
      "target",
      "bin",
      "obj",
    ]);
    const visit = async (directory: string): Promise<number> => {
      let entries: Array<{
        name: string;
        isFile(): boolean;
        isDirectory(): boolean;
      }>;
      try {
        entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
      } catch {
        return 0;
      }
      let removed = 0;
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isFile() && /^\..+\.agent-tmp-[0-9a-f-]{36}$/iu.test(entry.name)) {
          await removeIfPresent(path);
          removed += 1;
        } else if (entry.isDirectory() && !skippedDirectories.has(entry.name.toLowerCase())) {
          removed += await visit(path);
        }
      }
      return removed;
    };
    return visit(workspaceRoot);
  }
}

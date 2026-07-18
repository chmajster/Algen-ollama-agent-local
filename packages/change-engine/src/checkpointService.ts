import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { AtomicWriter } from "./atomicWriter.js";
import {
  CheckpointLimitError,
  CheckpointNotFoundError,
  SymlinkWriteBlockedError,
} from "./errors.js";
import { FileHashService } from "./fileHashService.js";
import type { ChangeValidator } from "./changeValidator.js";
import type { CheckpointFileEntry, CheckpointManifest, CheckpointSummary } from "./changeTypes.js";

export interface CheckpointServiceOptions {
  workspaceRoot: string;
  retention: number;
  maxTotalBytes: number;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function checkpointId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

function validId(id: string): boolean {
  return /^[0-9TZ-]+-[0-9a-f]{8}$/iu.test(id);
}

export class CheckpointService {
  private readonly agentRoot: string;
  private readonly checkpointsRoot: string;

  public constructor(
    private readonly options: CheckpointServiceOptions,
    private readonly validator: ChangeValidator,
    private readonly writer = new AtomicWriter(),
    private readonly hashes = new FileHashService(),
  ) {
    this.agentRoot = join(options.workspaceRoot, ".agent");
    this.checkpointsRoot = join(this.agentRoot, "checkpoints");
  }

  private async ensureControlledDirectories(): Promise<void> {
    for (const path of [this.agentRoot, this.checkpointsRoot]) {
      try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) throw new SymlinkWriteBlockedError();
        if (!metadata.isDirectory()) throw new SymlinkWriteBlockedError();
      } catch (error: unknown) {
        if (!isMissing(error)) throw error;
        await mkdir(path);
      }
    }
  }

  private checkpointDirectory(id: string): string {
    if (!validId(id)) throw new CheckpointNotFoundError();
    const path = resolve(this.checkpointsRoot, id);
    if (!path.startsWith(`${this.checkpointsRoot}${sep}`)) throw new CheckpointNotFoundError();
    return path;
  }

  public async create(
    changeSetId: string,
    task: string | undefined,
    paths: readonly string[],
  ): Promise<{ manifest: CheckpointManifest; totalBytes: number }> {
    await this.ensureControlledDirectories();
    const id = checkpointId();
    const directory = this.checkpointDirectory(id);
    const filesRoot = join(directory, "files");
    await mkdir(filesRoot, { recursive: true });
    const files: CheckpointFileEntry[] = [];
    let totalBytes = 0;

    try {
      for (const requestedPath of [...new Set(paths)].sort((left, right) =>
        left.localeCompare(right),
      )) {
        const target = await this.validator.target(requestedPath);
        let metadata: Awaited<ReturnType<typeof stat>>;
        try {
          metadata = await stat(target.absolutePath);
        } catch (error: unknown) {
          if (isMissing(error)) {
            files.push({ path: target.relativePath, existed: false });
            continue;
          }
          throw error;
        }
        if (!metadata.isFile())
          throw new CheckpointLimitError("Checkpoint może obejmować tylko pliki.");
        const backupPath = target.relativePath;
        const backupAbsolute = join(filesRoot, ...backupPath.split("/"));
        await mkdir(resolve(backupAbsolute, ".."), { recursive: true });
        await copyFile(target.absolutePath, backupAbsolute);
        const sha256 = await this.hashes.hashFile(target.absolutePath);
        files.push({
          path: target.relativePath,
          existed: true,
          sha256,
          sizeBytes: metadata.size,
          mode: metadata.mode & 0o777,
          backupPath,
        });
        totalBytes += metadata.size;
      }

      if (totalBytes > this.options.maxTotalBytes) {
        throw new CheckpointLimitError(
          `Checkpoint ma ${totalBytes} bajtów i przekracza łączny limit ${this.options.maxTotalBytes}.`,
        );
      }
      const manifest: CheckpointManifest = {
        id,
        createdAt: new Date().toISOString(),
        changeSetId,
        ...(task === undefined ? {} : { task }),
        files,
      };
      await this.writer.createFile(
        join(directory, "manifest.json"),
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      );
      await this.prune(id);
      return { manifest, totalBytes };
    } catch (error: unknown) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  public async getManifest(id: string): Promise<CheckpointManifest> {
    const path = join(this.checkpointDirectory(id), "manifest.json");
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || !("id" in parsed) || parsed.id !== id) {
        throw new CheckpointNotFoundError();
      }
      return parsed as CheckpointManifest;
    } catch (error: unknown) {
      if (error instanceof CheckpointNotFoundError) throw error;
      throw new CheckpointNotFoundError(undefined, undefined, { cause: error });
    }
  }

  public async list(): Promise<CheckpointSummary[]> {
    let entries: Array<{ isDirectory(): boolean; name: string }>;
    try {
      entries = await readdir(this.checkpointsRoot, { withFileTypes: true });
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
    const checkpoints: CheckpointSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !validId(entry.name)) continue;
      try {
        const manifest = await this.getManifest(entry.name);
        checkpoints.push({
          id: manifest.id,
          createdAt: manifest.createdAt,
          changeSetId: manifest.changeSetId,
          ...(manifest.task === undefined ? {} : { task: manifest.task }),
          filesCount: manifest.files.length,
          totalBytes: manifest.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
        });
      } catch {
        // Uszkodzony lub częściowy katalog nie jest prezentowany jako prawidłowy checkpoint.
      }
    }
    return checkpoints.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async prune(activeId: string): Promise<void> {
    const checkpoints = (await this.list()).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    let totalBytes = checkpoints.reduce((sum, checkpoint) => sum + checkpoint.totalBytes, 0);
    let count = checkpoints.length;
    for (const checkpoint of checkpoints) {
      if (count <= this.options.retention && totalBytes <= this.options.maxTotalBytes) {
        break;
      }
      if (checkpoint.id === activeId) continue;
      await rm(this.checkpointDirectory(checkpoint.id), { recursive: true, force: true });
      totalBytes -= checkpoint.totalBytes;
      count -= 1;
    }
    if (count > this.options.retention || totalBytes > this.options.maxTotalBytes) {
      throw new CheckpointLimitError();
    }
  }

  public async restore(id: string, selectedPaths?: readonly string[]): Promise<number> {
    const manifest = await this.getManifest(id);
    const directory = this.checkpointDirectory(id);
    const selected =
      selectedPaths === undefined
        ? undefined
        : new Set(selectedPaths.map((path) => path.replaceAll("\\", "/")));
    let restored = 0;
    for (const entry of manifest.files) {
      if (selected !== undefined && !selected.has(entry.path)) continue;
      const target = await this.validator.target(entry.path);
      if (!entry.existed) {
        try {
          const metadata = await lstat(target.absolutePath);
          if (!metadata.isFile()) throw new CheckpointLimitError("Rollback nie usunie katalogu.");
          await unlink(target.absolutePath);
          restored += 1;
        } catch (error: unknown) {
          if (!isMissing(error)) throw error;
        }
        continue;
      }
      if (entry.backupPath === undefined) throw new CheckpointNotFoundError();
      const backup = resolve(directory, "files", ...entry.backupPath.split("/"));
      const filesRoot = resolve(directory, "files");
      if (!backup.startsWith(`${filesRoot}${sep}`)) throw new CheckpointNotFoundError();
      const content = await readFile(backup);
      try {
        const metadata = await lstat(target.absolutePath);
        if (!metadata.isFile()) throw new CheckpointLimitError("Rollback nie nadpisze katalogu.");
        await this.writer.replaceFile(target.absolutePath, content);
      } catch (error: unknown) {
        if (!isMissing(error)) throw error;
        await this.writer.createFile(target.absolutePath, content);
      }
      if (entry.mode !== undefined) await chmod(target.absolutePath, entry.mode);
      restored += 1;
    }
    return restored;
  }
}

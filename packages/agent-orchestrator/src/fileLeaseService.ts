import { randomUUID } from "node:crypto";

import { FileLeaseConflictError } from "./errors.js";

export interface FileLease {
  id: string;
  taskNodeId: string;
  paths: string[];
  mode: "read" | "write";
  acquiredAt: string;
  expiresAt: string;
}

function normalize(path: string): string {
  const value = path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  if (value === "" || value.startsWith("../") || value.includes("/../") || value.includes("\0")) {
    throw new FileLeaseConflictError("Niepoprawna ścieżka lease.");
  }
  return value;
}

function conflicts(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export class FileLeaseService {
  private readonly leases = new Map<string, FileLease>();

  public acquire(input: {
    taskNodeId: string;
    paths: string[];
    mode: "read" | "write";
    timeoutMs: number;
    now?: Date;
  }): FileLease {
    const now = input.now ?? new Date();
    this.releaseExpired(now);
    const paths = [...new Set(input.paths.map(normalize))].sort();
    if (paths.length === 0)
      throw new FileLeaseConflictError("Lease wymaga co najmniej jednej ścieżki.");
    for (const lease of this.leases.values()) {
      if (lease.taskNodeId === input.taskNodeId) continue;
      if (input.mode === "read" && lease.mode === "read") continue;
      if (paths.some((path) => lease.paths.some((leased) => conflicts(path, leased)))) {
        throw new FileLeaseConflictError(
          `Ścieżka jest zajęta przez ${lease.taskNodeId}; scheduler nie będzie oczekiwał z innymi lease’ami.`,
        );
      }
    }
    const lease: FileLease = {
      id: randomUUID(),
      taskNodeId: input.taskNodeId,
      paths,
      mode: input.mode,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.timeoutMs).toISOString(),
    };
    this.leases.set(lease.id, lease);
    return structuredClone(lease);
  }

  public release(id: string): boolean {
    return this.leases.delete(id);
  }

  public releaseForTask(taskNodeId: string): void {
    for (const [id, lease] of this.leases) {
      if (lease.taskNodeId === taskNodeId) this.leases.delete(id);
    }
  }

  public releaseExpired(now = new Date()): number {
    let count = 0;
    for (const [id, lease] of this.leases) {
      if (Date.parse(lease.expiresAt) <= now.getTime()) {
        this.leases.delete(id);
        count += 1;
      }
    }
    return count;
  }

  public active(): FileLease[] {
    this.releaseExpired();
    return [...this.leases.values()].map((lease) => structuredClone(lease));
  }
}

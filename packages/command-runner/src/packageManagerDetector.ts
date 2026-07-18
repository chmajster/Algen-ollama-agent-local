import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { PackageManagerDetection } from "./commandTypes.js";
import type { ExecutableResolver } from "./executableResolver.js";

type Manager = Exclude<PackageManagerDetection["type"], "unknown">;

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export class PackageManagerDetector {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly resolver: ExecutableResolver,
  ) {}

  public async detect(): Promise<PackageManagerDetection> {
    const evidence: string[] = [];
    const candidates = new Set<Manager>();
    const lockfiles: Array<[string, Manager]> = [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lock", "bun"],
      ["bun.lockb", "bun"],
      ["package-lock.json", "npm"],
    ];
    for (const [file, manager] of lockfiles) {
      if (await exists(join(this.workspaceRoot, file))) {
        candidates.add(manager);
        evidence.push(file);
      }
    }
    let declaredVersion: string | undefined;
    try {
      const parsed = JSON.parse(
        await readFile(join(this.workspaceRoot, "package.json"), "utf8"),
      ) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "packageManager" in parsed &&
        typeof parsed.packageManager === "string"
      ) {
        const match = /^(npm|pnpm|yarn|bun)@(.+)$/u.exec(parsed.packageManager.trim());
        if (match?.[1] !== undefined) {
          candidates.add(match[1] as Manager);
          declaredVersion = match[2];
          evidence.push(`package.json#packageManager=${parsed.packageManager}`);
        }
      }
    } catch {
      // Brak albo niepoprawny package.json nie jest sam w sobie błędem detekcji.
    }
    if (candidates.size !== 1) {
      return {
        type: "unknown",
        confidence: candidates.size === 0 ? "low" : "low",
        evidence,
        executableAvailable: false,
        warnings: candidates.size > 1 ? ["Sprzeczne dowody menedżera pakietów."] : [],
      };
    }
    const type = [...candidates][0];
    if (type === undefined) throw new Error("Nieosiągalny stan detektora.");
    const executable = await this.resolver.resolve(type);
    return {
      type,
      confidence: declaredVersion === undefined ? "high" : "high",
      evidence,
      executableAvailable: executable.available,
      ...(declaredVersion === undefined ? {} : { version: declaredVersion }),
      warnings: executable.available ? [] : [`Program ${type} nie jest dostępny.`],
    };
  }
}

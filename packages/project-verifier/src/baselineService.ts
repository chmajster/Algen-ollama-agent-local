import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";

import { BaselineInvalidError } from "./errors.js";
import type { VerificationBaseline, VerificationResult } from "./verifierTypes.js";

const SKIPPED = new Set([
  ".agent",
  ".git",
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

function logical(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

async function controlledDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new BaselineInvalidError("Katalog baseline jest niedozwolony.");
  } catch (error: unknown) {
    const missing =
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    if (!missing) throw error;
    await mkdir(path);
  }
}

export class BaselineService {
  private readonly root: string;
  private readonly agentRoot: string;
  private readonly baselinesRoot: string;

  public constructor(workspaceRoot: string) {
    this.root = workspaceRoot;
    this.agentRoot = join(workspaceRoot, ".agent");
    this.baselinesRoot = join(this.agentRoot, "baselines");
  }

  public async snapshot(): Promise<Record<string, string>> {
    const root = await realpath(this.root);
    const values: Array<[string, string]> = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || SKIPPED.has(entry.name.toLowerCase())) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) {
          const metadata = await stat(path);
          if (metadata.size > 5 * 1024 * 1024) continue;
          values.push([
            logical(root, path),
            createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          ]);
        }
      }
    };
    await visit(root);
    return Object.fromEntries(values.sort(([left], [right]) => left.localeCompare(right)));
  }

  private workspaceHash(files: Record<string, string>): string {
    return createHash("sha256").update(JSON.stringify(files)).digest("hex");
  }

  public async create(result: VerificationResult): Promise<VerificationBaseline> {
    await controlledDirectory(this.agentRoot);
    await controlledDirectory(this.baselinesRoot);
    const fileHashes = await this.snapshot();
    const baseline: VerificationBaseline = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      workspaceHash: this.workspaceHash(fileHashes),
      steps: result.steps.map((step) => ({ ...step, stdoutExcerpt: "", stderrExcerpt: "" })),
      diagnostics: result.diagnostics,
      fileHashes,
    };
    const target = join(this.baselinesRoot, `${baseline.id}.json`);
    const temporary = `${target}.tmp-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(baseline, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, target);
    return baseline;
  }

  public async latest(
    allowedChangedFiles: readonly string[] = [],
  ): Promise<VerificationBaseline | undefined> {
    let files: string[];
    try {
      files = (await readdir(this.baselinesRoot)).filter((file) => file.endsWith(".json"));
    } catch {
      return undefined;
    }
    const baselines: VerificationBaseline[] = [];
    for (const file of files) {
      try {
        baselines.push(
          JSON.parse(
            await readFile(join(this.baselinesRoot, file), "utf8"),
          ) as VerificationBaseline,
        );
      } catch {
        // Uszkodzony albo częściowy baseline jest pomijany.
      }
    }
    const latest = baselines.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )[0];
    if (latest?.fileHashes === undefined) return latest;
    const allowed = new Set(allowedChangedFiles.map((path) => path.replaceAll("\\", "/")));
    const current = await this.snapshot();
    const keys = new Set([...Object.keys(latest.fileHashes), ...Object.keys(current)]);
    for (const key of keys) {
      if (allowed.has(key)) continue;
      if (latest.fileHashes[key] !== current[key])
        throw new BaselineInvalidError(undefined, { path: key });
    }
    return latest;
  }
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExecutableResolver, PackageManagerDetector } from "../src/index.js";

describe("PackageManagerDetector", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "manager-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function detect(pathValue = process.env.PATH ?? "") {
    return new PackageManagerDetector(
      root,
      new ExecutableResolver({ workspaceRoot: root, path: pathValue }),
    ).detect();
  }

  it.each([
    ["package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ] as const)("wykrywa %s jako %s", async (file, type) => {
    await writeFile(join(root, file), "fixture");
    expect(await detect()).toMatchObject({ type, confidence: "high", evidence: [file] });
  });

  it("uwzględnia packageManager i wersję", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@9.1.0" }));
    expect(await detect()).toMatchObject({ type: "pnpm", version: "9.1.0" });
  });

  it("nie zgaduje przy sprzecznych lockfile", async () => {
    await writeFile(join(root, "package-lock.json"), "{}");
    await writeFile(join(root, "yarn.lock"), "");
    expect(await detect()).toMatchObject({
      type: "unknown",
      warnings: [expect.stringContaining("Sprzeczne")],
    });
  });

  it("zwraca unknown bez dowodów", async () => {
    expect(await detect()).toMatchObject({ type: "unknown", confidence: "low", evidence: [] });
  });

  it("raportuje brak executable", async () => {
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    expect(await detect("")).toMatchObject({ type: "pnpm", executableAvailable: false });
  });
});

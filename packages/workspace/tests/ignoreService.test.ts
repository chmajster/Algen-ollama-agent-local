import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IgnoreService } from "../src/index.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workspace-ignore-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function service(respectGitignore = true, includeHiddenFiles = false): IgnoreService {
  return new IgnoreService({ root, respectGitignore, includeHiddenFiles });
}

describe("IgnoreService", () => {
  it("zawsze ignoruje .git", () => {
    expect(service().isIgnored(".git", true)).toBe(true);
  });

  it("zawsze ignoruje node_modules", () => {
    expect(service().isIgnored("apps/web/node_modules", true)).toBe(true);
  });

  it("domyślnie ignoruje .vscode", () => {
    expect(service().isIgnored(".vscode", true)).toBe(true);
  });

  it("respektuje główny .gitignore", async () => {
    await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
    const ignores = service();
    await ignores.loadRulesForDirectory(root, ".");
    expect(ignores.isIgnored("ignored.txt", false)).toBe(true);
  });

  it("nie stosuje .gitignore po wyłączeniu konfiguracji", async () => {
    await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
    const ignores = service(false);
    await ignores.loadRulesForDirectory(root, ".");
    expect(ignores.isIgnored("ignored.txt", false)).toBe(false);
  });

  it("respektuje zagnieżdżony .gitignore", async () => {
    const nested = join(root, "src");
    await mkdir(nested);
    await writeFile(join(nested, ".gitignore"), "generated.ts\n", "utf8");
    const ignores = service();
    await ignores.loadRulesForDirectory(root, ".");
    await ignores.loadRulesForDirectory(nested, "src");
    expect(ignores.isIgnored("src/generated.ts", false)).toBe(true);
  });

  it("ukrywa pliki ukryte przy ustawieniu domyślnym", () => {
    expect(service().isIgnored(".hidden", false)).toBe(true);
  });

  it("uwzględnia pliki ukryte po włączeniu konfiguracji", () => {
    expect(service(true, true).isIgnored(".hidden", false)).toBe(false);
  });

  it("rozpoznaje .git jako ścieżkę zablokowaną dla bezpośredniego odczytu", () => {
    expect(service().isAlwaysBlockedPath(".git/config")).toBe(true);
  });
});

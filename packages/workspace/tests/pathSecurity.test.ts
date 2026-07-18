import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PathOutsideWorkspaceError,
  PathSecurity,
  SymlinkEscapeError,
  WorkspaceAccessError,
} from "../src/index.js";

let sandbox: string;
let workspace: string;
let outside: string;
let security: PathSecurity;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "workspace-path-security-"));
  workspace = join(sandbox, "repo");
  outside = join(sandbox, "repo-other");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, "src", "index.ts"), "export {};\n", "utf8");
  await writeFile(join(outside, "secret.txt"), "outside", "utf8");
  security = await PathSecurity.create(workspace);
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("PathSecurity", () => {
  it("rozwiązuje poprawną ścieżkę względną", async () => {
    await expect(security.resolveFile("src/index.ts")).resolves.toMatchObject({
      relativePath: "src/index.ts",
    });
  });

  it("akceptuje ścieżkę absolutną wewnątrz workspace", async () => {
    await expect(security.resolveFile(resolve(workspace, "src/index.ts"))).resolves.toMatchObject({
      relativePath: "src/index.ts",
    });
  });

  it("blokuje traversal przez ..", async () => {
    await expect(security.resolveExisting("../repo-other/secret.txt")).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
  });

  it("blokuje ścieżkę absolutną poza workspace", async () => {
    await expect(security.resolveExisting(join(outside, "secret.txt"))).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
  });

  it("nie akceptuje katalogu o podobnym prefiksie", async () => {
    await expect(security.resolveExisting(outside)).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
  });

  it("blokuje dowiązanie symboliczne wychodzące poza workspace", async () => {
    const link = join(workspace, "external-link");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await expect(security.resolveExisting("external-link")).rejects.toBeInstanceOf(
      SymlinkEscapeError,
    );
  });

  it("obsługuje logiczne separatory Windows i Linux", async () => {
    const alternate = sep === "/" ? "src\\index.ts" : "src/index.ts";
    await expect(security.resolveFile(alternate)).resolves.toMatchObject({
      relativePath: "src/index.ts",
    });
  });

  it("zwraca kontrolowany błąd dla nieistniejącego pliku", async () => {
    await expect(security.resolveFile("missing.ts")).rejects.toBeInstanceOf(WorkspaceAccessError);
  });

  it("odrzuca katalog przekazany jako plik", async () => {
    await expect(security.resolveFile("src")).rejects.toThrow("nie jest plikiem");
  });
});

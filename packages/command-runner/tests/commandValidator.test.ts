import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CommandNotFoundError,
  CommandValidator,
  ExecutableResolver,
  UnsafeShellExpressionError,
  WorkingDirectoryError,
  detectPlatform,
  pathDelimiter,
  type CommandSpec,
} from "../src/index.js";

describe("ExecutableResolver i CommandValidator", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "resolver-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function executable(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "#!/usr/bin/env node\n");
    await chmod(path, 0o755);
  }

  function spec(overrides: Partial<CommandSpec> = {}): CommandSpec {
    return {
      id: "test",
      category: "test",
      executable: "node",
      args: ["--version"],
      cwd: root,
      timeoutMs: 1_000,
      networkAccess: false,
      writesFiles: false,
      source: "built_in",
      ...overrides,
    };
  }

  it("wykrywa platformę i separator", () => {
    expect(detectPlatform()).toMatchObject({
      processPlatform: process.platform,
      architecture: process.arch,
    });
    expect(["/", "\\"]).toContain(detectPlatform().pathSeparator);
  });

  it("wykrywa separator PATH dla Windows i POSIX", () => {
    expect(pathDelimiter("win32")).toBe(";");
    expect(pathDelimiter("linux")).toBe(":");
  });

  it("wykrywa dostępny globalny Node.js", async () => {
    const resolver = new ExecutableResolver({ workspaceRoot: root, path: process.env.PATH ?? "" });
    await expect(resolver.resolve("node")).resolves.toMatchObject({
      available: true,
      source: "path",
    });
  });

  it("zwraca brak nieznanego programu bez uruchamiania go", async () => {
    const resolver = new ExecutableResolver({ workspaceRoot: root, path: "" });
    await expect(resolver.resolve("definitely-not-a-tool")).resolves.toEqual({
      name: "definitely-not-a-tool",
      available: false,
      source: "unknown",
    });
  });

  it("preferuje lokalne node_modules/.bin", async () => {
    const name = process.platform === "win32" ? "eslint.cmd" : "eslint";
    await executable(join(root, "node_modules", ".bin", name));
    const resolver = new ExecutableResolver({ workspaceRoot: root, path: "" });
    await expect(resolver.resolve("eslint")).resolves.toMatchObject({
      available: true,
      source: "node_modules_bin",
    });
  });

  it("wykrywa lokalny program z .venv", async () => {
    const name = process.platform === "win32" ? "python.exe" : "python";
    const directory = process.platform === "win32" ? "Scripts" : "bin";
    await executable(join(root, ".venv", directory, name));
    const resolver = new ExecutableResolver({ workspaceRoot: root, path: "" });
    await expect(resolver.resolve("python")).resolves.toMatchObject({
      available: true,
      source: "workspace",
    });
  });

  it("nie podąża za lokalnym symlinkiem poza workspace", async () => {
    // Brak lokalnego pliku i pusty PATH daje ten sam bezpieczny rezultat bez zależności od uprawnień symlinków.
    const resolver = new ExecutableResolver({ workspaceRoot: root, path: "" });
    await expect(resolver.resolve("ruff")).resolves.toMatchObject({ available: false });
  });

  it("waliduje i kanonizuje cwd oraz executable", async () => {
    const resolver = new ExecutableResolver({ workspaceRoot: root });
    const result = await new CommandValidator(root, resolver).validate(spec());
    expect(result.cwd).toBe(
      await import("node:fs/promises").then(({ realpath }) => realpath(root)),
    );
    expect(resolve(result.executable)).toBe(result.executable);
  });

  it("blokuje cwd poza workspace", async () => {
    const resolver = new ExecutableResolver({ workspaceRoot: root });
    await expect(
      new CommandValidator(root, resolver).validate(spec({ cwd: resolve(root, "..") })),
    ).rejects.toBeInstanceOf(WorkingDirectoryError);
  });

  it("blokuje znak NUL i nowe linie w argumentach", async () => {
    const resolver = new ExecutableResolver({ workspaceRoot: root });
    await expect(
      new CommandValidator(root, resolver).validate(spec({ args: ["a\0b"] })),
    ).rejects.toBeInstanceOf(UnsafeShellExpressionError);
    await expect(
      new CommandValidator(root, resolver).validate(spec({ args: ["a\nb"] })),
    ).rejects.toBeInstanceOf(UnsafeShellExpressionError);
  });

  it("blokuje brak programu", async () => {
    const resolver = new ExecutableResolver({ workspaceRoot: root, path: "" });
    await expect(
      new CommandValidator(root, resolver).validate(spec({ executable: "pytest" })),
    ).rejects.toBeInstanceOf(CommandNotFoundError);
  });
});

import { chmod, cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExecutableResolver } from "@local-code-agent/command-runner";
import { ProjectScriptDetector, type ProjectVerifierOptions } from "../src/index.js";

describe("ProjectScriptDetector", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "script-detector-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function options(): ProjectVerifierOptions {
    return {
      workspaceRoot: root,
      commandTimeoutMs: 120_000,
      testTimeoutMs: 300_000,
      buildTimeoutMs: 300_000,
      baselineEnabled: true,
      accessMode: "readonly",
    };
  }

  async function detector() {
    const config = options();
    return new ProjectScriptDetector(config, new ExecutableResolver({ workspaceRoot: root }));
  }

  async function fixture(name: string): Promise<void> {
    const source = fileURLToPath(new URL(`../../../tests/fixtures/${name}`, import.meta.url));
    await rm(root, { recursive: true, force: true });
    await cp(source, root, { recursive: true });
  }

  it("wykrywa skrypty Node.js", async () => {
    await fixture("node-project");
    const result = await (await detector()).detect();
    expect(result.detection.projectType).toContain("node");
    expect(result.detection.commands.map((command) => command.category)).toEqual(
      expect.arrayContaining(["test", "lint", "typecheck", "build", "format"]),
    );
  });

  it("blokuje niebezpieczne skrypty package.json", async () => {
    await fixture("unsafe-project");
    const result = await (await detector()).detect();
    for (const name of ["deploy", "clean", "release"]) {
      const command = result.detection.commands.find((item) => item.id.endsWith(`:${name}`));
      expect(command).toMatchObject({ allowed: false, risk: "blocked" });
      expect(result.specs.has(command?.id ?? "")).toBe(false);
    }
  });

  it("wykrywa projekt Python i tylko narzędzia poparte konfiguracją", async () => {
    await fixture("python-project");
    const result = await (await detector()).detect();
    expect(result.detection.projectType).toContain("python");
    expect(result.detection.commands.map((item) => item.id)).toEqual(
      expect.arrayContaining(["python:pytest", "python:ruff", "python:mypy"]),
    );
  });

  it("wykrywa Cargo bez wymagania dostępnego programu", async () => {
    await fixture("rust-project");
    const result = await (await detector()).detect();
    expect(result.detection.projectType).toContain("rust");
    expect(result.detection.commands.map((item) => item.id)).toContain("rust:test");
  });

  it.each([
    ["go.mod", "module example.test/fixture", "go"],
    ["pom.xml", "<project/>", "java"],
    ["global.json", "{}", "dotnet"],
    ["composer.json", "{}", "php"],
  ])("wykrywa technologię na podstawie %s", async (file, content, projectType) => {
    await writeFile(join(root, file), content);
    expect((await (await detector()).detect()).detection.projectType).toContain(projectType);
  });

  it("preferuje wrapper Maven znajdujący się w workspace", async () => {
    const wrapper = join(root, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
    await writeFile(wrapper, "fixture");
    await chmod(wrapper, 0o755);
    if (process.platform === "win32") {
      // Detektor dowodu używa nazwy POSIX; dodaj również neutralny plik manifestu wrappera.
      await writeFile(join(root, "mvnw"), "fixture");
    }
    const result = await (await detector()).detect();
    expect(result.detection.commands.some((item) => item.id === "java:mvn-test")).toBe(true);
  });

  it("nie tworzy fałszywych poleceń w pustym projekcie", async () => {
    expect((await (await detector()).detect()).detection).toMatchObject({
      projectType: [],
      commands: [],
    });
    expect(await readdir(root)).toEqual([]);
  });
});

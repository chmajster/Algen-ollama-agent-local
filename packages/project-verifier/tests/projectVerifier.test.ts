import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandRunner } from "@local-code-agent/command-runner";
import { ProjectVerifier } from "../src/index.js";

describe("ProjectVerifier integration", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "project-verifier-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createNodeProject(): Promise<void> {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "controlled-verifier-project",
        version: "1.0.0",
        scripts: {
          test: "node scripts/test.cjs",
          lint: "node scripts/lint.cjs",
          typecheck: "node scripts/typecheck.cjs",
          build: "node scripts/build.cjs",
        },
      }),
    );
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        name: "controlled-verifier-project",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: { "": { name: "controlled-verifier-project", version: "1.0.0" } },
      }),
    );
    await writeFile(join(root, "scripts", "test.cjs"), 'console.log("Tests  2 passed")\n');
    await writeFile(join(root, "scripts", "lint.cjs"), 'console.log("lint passed")\n');
    await writeFile(
      join(root, "scripts", "typecheck.cjs"),
      'console.error("src/index.ts(1,1): error TS2322: controlled failure")\nprocess.exitCode = 1\n',
    );
    await writeFile(join(root, "scripts", "build.cjs"), 'console.log("build passed")\n');
    await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
  }

  function verifier(): ProjectVerifier {
    const runner = new CommandRunner({
      workspaceRoot: root,
      sessionId: "verifier-test",
      policy: {
        enabled: true,
        policy: "verification",
        allowNetwork: false,
        allowPackageInstall: false,
        allowPackageScripts: true,
        allowCustomCommands: false,
        allowFormatCommands: true,
        maxCommandsPerSession: 30,
      },
      outputLimits: { maxChars: 100_000, maxLines: 5_000, maxBytes: 1_048_576 },
      maxParallelCommands: 1,
      allowEnvOverrides: false,
      allowedEnvVars: [
        "PATH",
        "HOME",
        "USERPROFILE",
        "TEMP",
        "TMP",
        "TMPDIR",
        "SystemRoot",
        "COMSPEC",
        "PATHEXT",
        "LANG",
        "LC_ALL",
        "TERM",
      ],
    });
    return new ProjectVerifier(
      {
        workspaceRoot: root,
        commandTimeoutMs: 10_000,
        testTimeoutMs: 10_000,
        buildTimeoutMs: 10_000,
        baselineEnabled: true,
        accessMode: "readonly",
      },
      runner,
    );
  }

  it("wykrywa i uruchamia polecenie wyłącznie po aktualnym identyfikatorze", async () => {
    await createNodeProject();
    const service = verifier();
    const detection = await service.detectProjectCommands();
    const test = detection.commands.find((command) => command.category === "test");

    expect(test).toMatchObject({ allowed: true, args: ["run", "test"] });
    const result = await service.runProjectCommand(test?.id ?? "", "Kontrolowany test projektu.");
    expect(result.result).toMatchObject({ status: "success", exitCode: 0 });
    expect(result.testSummary).toMatchObject({ testsPassed: 2, testsTotal: 2 });
  });

  it("odrzuca identyfikator, którego nie ma w świeżej detekcji", async () => {
    await createNodeProject();
    await expect(
      verifier().runProjectCommand("node:.:arbitrary", "Nieznane polecenie projektu."),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PROJECT_COMMAND" });
  });

  it("wykonuje kolejne kroki planu mimo kontrolowanego błędu typecheck", async () => {
    await createNodeProject();
    const result = await verifier().verify({
      scope: "workspace",
      reason: "Pełna kontrolowana weryfikacja.",
    });

    expect(result.status).toBe("failed");
    expect(result.steps.map((step) => step.category)).toEqual([
      "lint",
      "typecheck",
      "test",
      "build",
    ]);
    expect(result.steps.find((step) => step.category === "build")?.status).toBe("passed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "TS2322", file: "src/index.ts" })]),
    );
  });

  it("rozpoznaje diagnostykę istniejącą w baseline", async () => {
    await createNodeProject();
    const service = verifier();
    await service.createBaseline({ scope: "workspace", reason: "Baseline przed zmianą." });
    await writeFile(join(root, "src", "other.ts"), "export const other = true;\n");

    const result = await service.verify({
      scope: "workspace",
      changedFiles: ["src/other.ts"],
      reason: "Weryfikacja po zmianie niezwiązanej z błędem.",
    });

    expect(result.preExistingIssues).toHaveLength(1);
    expect(result.regressions).toHaveLength(0);
  });

  it("blokuje identyczną pełną weryfikację, gdy projekt się nie zmienił", async () => {
    await createNodeProject();
    const service = verifier();
    const input = {
      scope: "workspace" as const,
      include: ["tests"] as const,
      reason: "Pierwsza weryfikacja testów.",
    };
    await service.verify({ ...input, include: [...input.include] });

    await expect(service.verify({ ...input, include: [...input.include] })).rejects.toMatchObject({
      code: "VERIFICATION_UNAVAILABLE",
      details: { reason: "NO_CHANGES_SINCE_VERIFICATION" },
    });
  });

  it("dla changed_files pomija polecenia niedotkniętego pakietu", async () => {
    await mkdir(join(root, "packages", "a"), { recursive: true });
    await mkdir(join(root, "packages", "b"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "monorepo", private: true, workspaces: ["packages/*"] }),
    );
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({ name: "monorepo", lockfileVersion: 3, packages: {} }),
    );
    for (const name of ["a", "b"]) {
      await writeFile(
        join(root, "packages", name, "package.json"),
        JSON.stringify({
          name: `package-${name}`,
          version: "1.0.0",
          scripts: { test: `node -e "console.log('Tests  1 passed')"` },
        }),
      );
    }

    const result = await verifier().verify({
      scope: "changed_files",
      include: ["tests"],
      changedFiles: ["packages/a/src/index.ts"],
      reason: "Test dotkniętego pakietu.",
    });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.commandId).toBe("node:packages/a:test");
  });
});

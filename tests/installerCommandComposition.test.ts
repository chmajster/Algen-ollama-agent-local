import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("installer command composition", () => {
  it("keeps the executable separate and emits each npm argument once", () => {
    const installerPath = resolve("install.ps1");
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installerPath,
        "-TestCommandComposition",
      ],
      {
        encoding: "utf8",
      },
    ).trim();

    expect(output).toBe('npm.cmd run format:check --prefix C:\\repo');
    expect(output).not.toContain("run format:check run format:check");
  });

  it("normalizes an empty git status capture before checking Count", () => {
    const installer = readFileSync(resolve("install.ps1"), "utf8");

    expect(installer).toMatch(/\$dirty\s*=\s*@\(Invoke-External[^\r\n]+status[^\r\n]+-Capture\)/u);
  });

  it("builds the runtime through an absolute project path", () => {
    const installer = readFileSync(resolve("install.ps1"), "utf8");

    expect(installer).toContain(
      '$runtimeProject = Join-Path $script:RepositoryDirectory "apps\\agent-runtime"',
    );
    expect(installer).toMatch(/"-b",\s*\$runtimeProject/u);
  });
});

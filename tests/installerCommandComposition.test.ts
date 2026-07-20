import { execFileSync } from "node:child_process";
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
});

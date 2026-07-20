import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("installer command composition", () => {
  it("keeps the executable separate and emits each npm argument once", () => {
    const modulePath = resolve("scripts", "InstallerCommand.psm1");
    const script = [
      `Import-Module '${modulePath.replaceAll("'", "''")}' -Force`,
      "Format-ExternalCommand -FilePath 'C:\\Program Files\\nodejs\\npm.cmd' -Arguments @('run','format:check','--prefix','C:\\repo')",
    ].join("; ");
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
      encoding: "utf8",
      },
    ).trim();

    expect(output).toBe('npm.cmd run format:check --prefix C:\\repo');
    expect(output).not.toContain("run format:check run format:check");
  });
});

import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { ProcessTreeKiller } from "../src/index.js";

function waitForPid(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    let value = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      value += chunk.toString("utf8");
      const pid = Number(value.trim());
      if (Number.isInteger(pid) && pid > 0) resolvePromise(pid);
    });
    child.once("error", reject);
  });
}

describe("ProcessTreeKiller", () => {
  it("kończy proces nadrzędny i jego dziecko", async () => {
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log(child.pid);
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ["-e", script], {
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const childPid = await waitForPid(parent);
    await new ProcessTreeKiller().terminate(parent, 50);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    expect(parent.exitCode !== null || parent.signalCode !== null).toBe(true);
    expect(() => process.kill(childPid, 0)).toThrow();
  }, 10_000);

  it("jest idempotentny dla zakończonego procesu", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
    await expect(new ProcessTreeKiller().terminate(child)).resolves.toBeUndefined();
  });
});

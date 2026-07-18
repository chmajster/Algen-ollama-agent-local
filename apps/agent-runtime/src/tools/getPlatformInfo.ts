import { arch, platform, release, type } from "node:os";
import { basename, sep } from "node:path";

import { z } from "zod";

import type { AgentTool } from "./toolTypes.js";
import { createToolDefinition } from "./toolTypes.js";

const argsSchema = z.object({}).strict();

export interface PlatformInfo {
  operatingSystem: string;
  operatingSystemRelease: string;
  processPlatform: NodeJS.Platform;
  architecture: string;
  nodeVersion: string;
  defaultShell: string;
  pathSeparator: string;
  workingDirectory: string;
  isWindows: boolean;
  isLinux: boolean;
  isMacOS: boolean;
}

function defaultShellName(): string {
  const configuredShell = process.env.SHELL ?? process.env.ComSpec;
  if (configuredShell !== undefined && configuredShell.trim() !== "") {
    return basename(configuredShell);
  }
  return process.platform === "win32" ? "nie wykryto (Windows)" : "nie wykryto";
}

export const getPlatformInfoTool: AgentTool<z.infer<typeof argsSchema>, PlatformInfo> = {
  name: "get_platform_info",
  description:
    "Zwraca niewrażliwe informacje o systemie operacyjnym, Node.js, powłoce i katalogu roboczym.",
  schema: argsSchema,
  definition: createToolDefinition(
    "get_platform_info",
    "Zwraca niewrażliwe informacje o systemie operacyjnym, Node.js, powłoce i katalogu roboczym.",
    argsSchema,
  ),
  async execute(): Promise<PlatformInfo> {
    const currentPlatform = platform();
    return {
      operatingSystem: type(),
      operatingSystemRelease: release(),
      processPlatform: currentPlatform,
      architecture: arch(),
      nodeVersion: process.version,
      defaultShell: defaultShellName(),
      pathSeparator: sep,
      workingDirectory: process.cwd(),
      isWindows: currentPlatform === "win32",
      isLinux: currentPlatform === "linux",
      isMacOS: currentPlatform === "darwin",
    };
  },
};

import { delimiter } from "node:path";

import type { PlatformInfo } from "./commandTypes.js";

export function detectPlatform(
  processPlatform: NodeJS.Platform = process.platform,
  architecture = process.arch,
): Omit<PlatformInfo, "defaultShell" | "availableShells"> {
  const platform =
    processPlatform === "win32" ? "windows" : processPlatform === "darwin" ? "macos" : "linux";
  return {
    platform,
    processPlatform,
    architecture,
    pathSeparator: processPlatform === "win32" ? "\\" : "/",
    caseSensitiveFileSystem: platform === "linux",
  };
}

export function pathDelimiter(processPlatform: NodeJS.Platform = process.platform): string {
  return processPlatform === process.platform ? delimiter : processPlatform === "win32" ? ";" : ":";
}

import type { PlatformInfo } from "./commandTypes.js";
import type { ExecutableResolver } from "./executableResolver.js";
import { detectPlatform } from "./platformDetector.js";

export class ShellDetector {
  public constructor(private readonly resolver: ExecutableResolver) {}

  public async detect(): Promise<PlatformInfo> {
    const platform = detectPlatform();
    const names =
      platform.platform === "windows"
        ? (["pwsh", "powershell", "cmd"] as const)
        : (["bash", "sh", "zsh"] as const);
    const detected = await Promise.all(
      names.map(async (name) => ({ name, info: await this.resolver.resolve(name) })),
    );
    const availableShells = detected.filter(({ info }) => info.available).map(({ name }) => name);
    const preferred = detected.find(({ info }) => info.available)?.info.resolvedPath;
    return {
      ...platform,
      availableShells,
      ...(preferred === undefined ? {} : { defaultShell: preferred }),
    };
  }
}

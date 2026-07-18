import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { CommandSpec } from "./commandTypes.js";
import {
  CommandNotFoundError,
  UnsafeShellExpressionError,
  WorkingDirectoryError,
} from "./errors.js";
import type { ExecutableResolver } from "./executableResolver.js";

function outside(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference);
}

export class CommandValidator {
  private readonly workspaceRoot: Promise<string>;

  public constructor(
    workspaceRoot: string,
    private readonly resolver: ExecutableResolver,
  ) {
    this.workspaceRoot = realpath(resolve(workspaceRoot));
  }

  public async validate(command: CommandSpec): Promise<CommandSpec> {
    const root = await this.workspaceRoot;
    let cwd: string;
    try {
      cwd = await realpath(resolve(command.cwd));
      if (outside(root, cwd) || !(await stat(cwd)).isDirectory()) throw new WorkingDirectoryError();
    } catch (error: unknown) {
      if (error instanceof WorkingDirectoryError) throw error;
      throw new WorkingDirectoryError(undefined, undefined, { cause: error });
    }
    if (command.args.some((arg) => arg.includes("\0") || /[\r\n]/u.test(arg))) {
      throw new UnsafeShellExpressionError();
    }
    let executable = command.executable;
    if (!isAbsolute(executable)) {
      const resolved = await this.resolver.resolve(executable);
      if (!resolved.available || resolved.resolvedPath === undefined) {
        throw new CommandNotFoundError(undefined, { executable });
      }
      executable = resolved.resolvedPath;
    } else {
      try {
        await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      } catch (error: unknown) {
        throw new CommandNotFoundError(undefined, { executable }, { cause: error });
      }
    }
    if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1) {
      throw new UnsafeShellExpressionError("Nieprawidłowy timeout polecenia.");
    }
    return { ...command, executable, cwd, args: [...command.args] };
  }
}

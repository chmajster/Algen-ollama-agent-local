import type * as vscode from "vscode";

export class ExtensionLogger {
  public constructor(
    private readonly channel: vscode.OutputChannel,
    private readonly debugEnabled: () => boolean,
  ) {}

  private write(level: string, message: string): void {
    const safe = message.replace(
      /(token|password|secret|credential)\s*[=:]\s*\S+/giu,
      "$1=[pominięto]",
    );
    this.channel.appendLine(`${new Date().toISOString()} [${level}] ${safe.slice(0, 8_000)}`);
  }

  public error(message: string): void {
    this.write("error", message);
  }
  public warn(message: string): void {
    this.write("warn", message);
  }
  public info(message: string): void {
    this.write("info", message);
  }
  public debug(message: string): void {
    if (this.debugEnabled()) this.write("debug", message);
  }
  public show(): void {
    this.channel.show(true);
  }
}

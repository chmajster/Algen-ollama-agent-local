import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  CommandPolicyContext,
  CommandPolicyDecision,
  CommandPolicyOptions,
  CommandSpec,
} from "./commandTypes.js";

const BLOCKED_PROGRAMS = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "remove-item",
  "format",
  "mkfs",
  "diskpart",
  "dd",
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  "sudo",
  "su",
  "runas",
  "takeown",
  "icacls",
  "reg",
  "regedit",
  "sc",
  "systemctl",
  "service",
  "passwd",
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "nc",
  "ncat",
  "telnet",
  "invoke-webrequest",
  "invoke-restmethod",
  "eval",
  "net",
  "kubectl",
  "terraform",
  "ansible-playbook",
]);
const VERIFICATION_CATEGORIES = new Set([
  "version",
  "test",
  "lint",
  "typecheck",
  "build",
  "format",
  "diagnostic",
]);
const INSTALL_WORDS = /^(?:install|add|update|upgrade|sync|ci)$/iu;
const DANGEROUS_WORDS =
  /(?:deploy|release|publish|upload|push|production|prod|migrate|seed|reset|checkout|drop|clean|destroy|terraform|ansible|remote|serve|start|dev|watch)/iu;
const NETWORK_WORDS =
  /(?:https?:\/\/|curl|wget|invoke-webrequest|invoke-restmethod|ssh|scp|ftp|telnet|npm\s+publish|docker\s+(?:push|login))/iu;
const SHELL_OPERATORS = /(?:&&|\|\||;|`|\$\(|(?:^|\s)[|<>](?:\s|$)|&\s*$)/u;
const SCRIPT_OPERATORS = /(?:&&|\|\||[;`]|\$\(|[|<>]|&\s*$)/u;
const DANGEROUS_SCRIPT_PROGRAM =
  /(?:^|\s)(?:rm|rmdir|del|erase|sudo|shutdown|mkfs|dd|powershell|pwsh|cmd|bash|sh)(?:\s|$)/iu;

function executableName(value: string): string {
  return basename(value)
    .replace(/\.(?:exe|cmd|bat)$/iu, "")
    .toLowerCase();
}

function outside(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference);
}

export class DefaultCommandPolicy {
  public constructor(private readonly options: CommandPolicyOptions) {}

  public evaluate(command: CommandSpec, context: CommandPolicyContext): CommandPolicyDecision {
    const reasons: string[] = [];
    const executable = executableName(command.executable);
    const argsText = command.args.join(" ");
    if (!this.options.enabled || this.options.policy === "disabled")
      reasons.push("Wykonywanie poleceń jest wyłączone.");
    if (outside(context.workspaceRoot, command.cwd))
      reasons.push("Katalog roboczy wychodzi poza workspace.");
    if (context.commandsExecuted >= this.options.maxCommandsPerSession)
      reasons.push("Przekroczono limit poleceń sesji.");
    if (BLOCKED_PROGRAMS.has(executable))
      reasons.push(`Program ${executable} jest bezwarunkowo zablokowany.`);
    if (
      ["cmd", "bash", "sh", "zsh"].includes(executable) &&
      command.args.some((arg) => ["/c", "-c"].includes(arg.toLowerCase()))
    ) {
      reasons.push("Dowolne wykonanie przez powłokę jest zablokowane.");
    }
    if (
      ["powershell", "pwsh"].includes(executable) &&
      command.args.some((arg) =>
        ["-encodedcommand", "-enc", "-command", "-c"].includes(arg.toLowerCase()),
      )
    ) {
      reasons.push("Polecenia PowerShell przekazane jako tekst są zablokowane.");
    }
    if (command.args.some((arg) => SHELL_OPERATORS.test(arg)))
      reasons.push("Argument zawiera operator powłoki.");
    if (command.scriptText !== undefined) {
      if (SCRIPT_OPERATORS.test(command.scriptText))
        reasons.push("Skrypt projektu zawiera operator powłoki.");
      if (DANGEROUS_WORDS.test(command.scriptText))
        reasons.push("Skrypt projektu wskazuje operację wdrożeniową, watch albo destrukcyjną.");
      if (DANGEROUS_SCRIPT_PROGRAM.test(command.scriptText))
        reasons.push("Skrypt projektu uruchamia niedozwolony program.");
      if (NETWORK_WORDS.test(command.scriptText))
        reasons.push("Skrypt projektu może korzystać z sieci.");
    }
    if (command.networkAccess && !this.options.allowNetwork)
      reasons.push("Dostęp do sieci jest wyłączony.");
    if (NETWORK_WORDS.test(`${executable} ${argsText}`) && !this.options.allowNetwork)
      reasons.push("Polecenie może korzystać z sieci.");
    if (
      ["npm", "pnpm", "yarn", "bun", "pip", "pip3", "poetry", "uv", "cargo", "composer"].includes(
        executable,
      ) &&
      command.args.some((arg) => INSTALL_WORDS.test(arg)) &&
      !this.options.allowPackageInstall
    ) {
      reasons.push("Instalowanie lub aktualizowanie pakietów jest wyłączone.");
    }
    if (DANGEROUS_WORDS.test(argsText)) reasons.push("Argumenty wskazują niedozwoloną operację.");
    if (executable === "chmod" && command.args.includes("-R"))
      reasons.push("Rekursywna zmiana uprawnień jest zablokowana.");
    if (executable === "chown" && command.args.includes("-R"))
      reasons.push("Rekursywna zmiana właściciela jest zablokowana.");
    if (executable === "docker" && command.args.some((arg) => arg.toLowerCase() === "login"))
      reasons.push("Logowanie do rejestru kontenerów jest bezwarunkowo zablokowane.");
    for (const argument of command.args) {
      const pathCandidate = argument.includes("=")
        ? argument.slice(argument.lastIndexOf("=") + 1)
        : argument;
      if (
        (pathCandidate.startsWith("../") || pathCandidate.startsWith("..\\")) &&
        outside(context.workspaceRoot, resolve(command.cwd, pathCandidate))
      ) {
        reasons.push("Argument ścieżki wychodzi poza workspace.");
      }
      if (isAbsolute(pathCandidate) && outside(context.workspaceRoot, pathCandidate))
        reasons.push("Bezwzględny argument ścieżki wychodzi poza workspace.");
    }
    if (command.source === "detected_script" && !this.options.allowPackageScripts)
      reasons.push("Skrypty projektu są wyłączone.");
    if (
      command.category === "custom" &&
      (!this.options.allowCustomCommands || this.options.policy !== "custom")
    )
      reasons.push("Polecenia niestandardowe są wyłączone.");
    if (this.options.policy === "verification" && !VERIFICATION_CATEGORIES.has(command.category))
      reasons.push("Kategoria nie należy do polityki verification.");
    if (command.category === "format" && !this.options.allowFormatCommands)
      reasons.push("Polecenia formatujące są wyłączone.");
    if (command.writesFiles && context.accessMode !== "write")
      reasons.push("Polecenie zapisujące wymaga trybu write.");
    if (reasons.length > 0)
      return { allowed: false, requiresConfirmation: false, risk: "blocked", reasons };
    const requiresConfirmation =
      command.writesFiles ||
      command.networkAccess ||
      command.category === "custom" ||
      command.source === "user_config";
    return {
      allowed: true,
      requiresConfirmation,
      risk: requiresConfirmation ? "medium" : command.category === "build" ? "low" : "safe",
      reasons: [],
    };
  }
}

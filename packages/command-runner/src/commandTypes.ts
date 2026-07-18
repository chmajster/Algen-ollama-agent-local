export type CommandCategory =
  "version" | "test" | "lint" | "typecheck" | "build" | "format" | "diagnostic" | "custom";

export type CommandSource = "detected_script" | "built_in" | "user_config" | "agent_request";
export type CommandPolicyName = "disabled" | "verification" | "restricted" | "custom";

export interface CommandSpec {
  id: string;
  category: CommandCategory;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  environment?: Record<string, string>;
  networkAccess: boolean;
  writesFiles: boolean;
  source: CommandSource;
  displayName?: string;
  scriptText?: string;
}

export interface CommandPolicyContext {
  workspaceRoot: string;
  accessMode: "readonly" | "preview" | "write";
  commandsExecuted: number;
}

export interface CommandPolicyDecision {
  allowed: boolean;
  requiresConfirmation: boolean;
  risk: "safe" | "low" | "medium" | "high" | "blocked";
  reasons: string[];
}

export interface CommandPolicyOptions {
  enabled: boolean;
  policy: CommandPolicyName;
  allowNetwork: boolean;
  allowPackageInstall: boolean;
  allowPackageScripts: boolean;
  allowCustomCommands: boolean;
  allowFormatCommands: boolean;
  maxCommandsPerSession: number;
}

export interface OutputLimits {
  maxChars: number;
  maxLines: number;
  maxBytes: number;
}

export interface CommandResult {
  id: string;
  command: {
    executable: string;
    args: string[];
    cwd: string;
    category: CommandCategory;
  };
  status: "success" | "failed" | "timeout" | "aborted" | "blocked" | "spawn_error";
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outputBytes: number;
  policyDecision?: CommandPolicyDecision;
}

export interface ExecutableInfo {
  name: string;
  available: boolean;
  resolvedPath?: string;
  version?: string;
  source: "path" | "workspace" | "node_modules_bin" | "unknown";
}

export interface PlatformInfo {
  platform: "windows" | "linux" | "macos";
  processPlatform: NodeJS.Platform;
  architecture: string;
  defaultShell?: string;
  availableShells: Array<"powershell" | "pwsh" | "cmd" | "bash" | "zsh" | "sh">;
  pathSeparator: string;
  caseSensitiveFileSystem: boolean;
}

export interface PackageManagerDetection {
  type: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  confidence: "high" | "medium" | "low";
  evidence: string[];
  executableAvailable: boolean;
  version?: string;
  warnings: string[];
}

export interface CommandHistoryEntry {
  timestamp: string;
  sessionId: string;
  commandId: string;
  category: string;
  executable: string;
  args: string[];
  cwd: string;
  policy: string;
  decision: "allowed" | "blocked";
  status?: string;
  exitCode?: number | null;
  durationMs?: number;
  outputTruncated?: boolean;
  reason?: string;
}

export interface CommandRunnerStatistics {
  commandsRun: number;
  commandsBlocked: number;
  commandsTimedOut: number;
  commandsAborted: number;
  commandOutputBytes: number;
}

export interface CommandRunnerOptions {
  workspaceRoot: string;
  sessionId: string;
  policy: CommandPolicyOptions;
  outputLimits: OutputLimits;
  maxParallelCommands: number;
  allowEnvOverrides: boolean;
  allowedEnvVars: string[];
}

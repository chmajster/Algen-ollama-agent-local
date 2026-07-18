import {
  runtimeSettingsSchema,
  type AgentMode,
  type RuntimeSettings,
} from "@local-code-agent/runtime-protocol";
import { z } from "zod";

export interface ConfigurationReader {
  get<T>(key: string): T | undefined;
  inspect?<T>(
    key: string,
  ):
    { globalValue?: T; defaultValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined;
}

const extensionSettingsSchema = z
  .object({
    runtime: runtimeSettingsSchema,
    restartOnCrash: z.boolean(),
    showToolCalls: z.boolean(),
    showCommandOutput: z.boolean(),
    compactMode: z.boolean(),
    historyEnabled: z.boolean(),
    historyMaxItems: z.number().int().min(1).max(50),
    storeFullPrompts: z.literal(false),
  })
  .strict();

export type ExtensionSettings = z.infer<typeof extensionSettingsSchema>;

export interface SettingsMapping {
  settings: ExtensionSettings;
  warnings: string[];
}

function value<T>(configuration: ConfigurationReader, key: string, fallback: T): T {
  return configuration.get<T>(key) ?? fallback;
}

function userValue<T>(configuration: ConfigurationReader, key: string, fallback: T): T {
  return configuration.inspect?.<T>(key)?.globalValue ?? fallback;
}

function githubBaseUrl(
  raw: string,
  fallback: string,
  allowEnterprise: boolean,
  warnings: string[],
): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") throw new Error("https");
    if (!allowEnterprise && url.origin !== new URL(fallback).origin) {
      warnings.push(
        "Niestandardowy host GitHub wymaga allowEnterprise w ustawieniach użytkownika.",
      );
      return fallback;
    }
    return url.toString().replace(/\/$/u, "");
  } catch {
    warnings.push(`Nieprawidłowy adres GitHub; przywrócono ${fallback}.`);
    return fallback;
  }
}

function localOllamaHost(raw: string, warnings: string[]): string {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("protocol");
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
      warnings.push("Ollama host nie jest lokalny; przywrócono http://127.0.0.1:11434.");
      return "http://127.0.0.1:11434";
    }
    return url.toString().replace(/\/$/u, "");
  } catch {
    warnings.push("Nieprawidłowy Ollama host; przywrócono http://127.0.0.1:11434.");
    return "http://127.0.0.1:11434";
  }
}

export class SettingsMapper {
  public map(configuration: ConfigurationReader, workspaceTrusted: boolean): SettingsMapping {
    const warnings: string[] = [];
    const configuredMode = value<AgentMode>(configuration, "defaultMode", "ask");
    const confirmation = value(configuration, "requireWriteConfirmation", true);
    if (!confirmation) warnings.push("requireWriteConfirmation=false zostało zignorowane.");
    const storeFullPrompts = value(configuration, "history.storeFullPrompts", false);
    if (storeFullPrompts) warnings.push("Pełne prompty nie są zapisywane na tym etapie.");
    const remoteEnabled = workspaceTrusted && value(configuration, "remote.enabled", false);
    for (const key of [
      "orchestration.requirePlanApproval",
      "orchestration.requireFinalApproval",
      "orchestration.requireIndependentReview",
      "orchestration.requireSecurityReview",
    ] as const) {
      if (!userValue(configuration, key, true)) warnings.push(`${key}=false zostało zignorowane.`);
    }
    const allowEnterprise = userValue(configuration, "github.allowEnterprise", false);
    for (const key of [
      "github.allowIssueCreation",
      "github.allowIssueClosing",
      "github.allowMerge",
      "github.allowBranchDelete",
      "github.allowForcePush",
    ] as const) {
      if (value(configuration, key, false)) {
        warnings.push(`${key}=true zostało zignorowane; operacja jest zablokowana.`);
      }
    }
    for (const key of [
      "github.requirePushConfirmation",
      "github.requirePullRequestConfirmation",
      "github.requireCommentConfirmation",
      "github.requireResolveThreadConfirmation",
    ] as const) {
      if (!value(configuration, key, true)) warnings.push(`${key}=false zostało zignorowane.`);
    }
    const runtime: RuntimeSettings = {
      ollamaHost: localOllamaHost(
        value(configuration, "ollama.host", "http://127.0.0.1:11434"),
        warnings,
      ),
      ollamaModel: value(configuration, "ollama.model", "qwen3.5:9b"),
      maxSteps: 20,
      contextLength: value(configuration, "ollama.contextLength", 32_768),
      temperature: value(configuration, "ollama.temperature", 0.1),
      mode: workspaceTrusted ? configuredMode : "ask",
      autoStartRuntime: value(configuration, "runtime.autoStart", false),
      verificationEnabled: workspaceTrusted,
      requireWriteConfirmation: true,
      verifyAfterApply: workspaceTrusted && value(configuration, "verifyAfterApply", true),
      verificationScope: value(configuration, "verificationScope", "affected_packages"),
      commandPolicy: workspaceTrusted
        ? value(configuration, "commands.policy", "verification")
        : "disabled",
      allowNetwork: workspaceTrusted && value(configuration, "commands.allowNetwork", false),
      allowPackageInstall:
        workspaceTrusted && value(configuration, "commands.allowPackageInstall", false),
      allowFileDelete: false,
      allowFileMove: workspaceTrusted,
      rollbackOnVerificationFailure: false,
      maxRepairAttempts: value(configuration, "maxRepairAttempts", 3),
      respectGitignore: value(configuration, "workspace.respectGitignore", true),
      includeHiddenFiles:
        workspaceTrusted && value(configuration, "workspace.includeHiddenFiles", false),
      allowSensitiveFiles:
        workspaceTrusted && value(configuration, "workspace.allowSensitiveFiles", false),
      commandsEnabled: workspaceTrusted && value(configuration, "commands.enabled", true),
      debug: value(configuration, "runtime.debug", false),
      orchestrationEnabled: workspaceTrusted && value(configuration, "orchestration.enabled", true),
      orchestrationDefaultMode: value(configuration, "orchestration.defaultMode", "analysis"),
      orchestrationMaxAgents: value(configuration, "orchestration.maxAgents", 8),
      orchestrationMaxParallelAgents: value(configuration, "orchestration.maxParallelAgents", 3),
      orchestrationRequirePlanApproval: true,
      orchestrationRequireFinalApproval: true,
      orchestrationRequireIndependentReview: true,
      orchestrationRequireSecurityReview: true,
      orchestrationShowAgentActivity: value(configuration, "orchestration.showAgentActivity", true),
      orchestrationShowTaskGraph: value(configuration, "orchestration.showTaskGraph", true),
      remoteEnabled,
      remoteProvider: "github",
      githubAuthenticationMode: value(configuration, "github.authenticationMode", "vscode"),
      githubApiBaseUrl: githubBaseUrl(
        userValue(configuration, "github.apiBaseUrl", "https://api.github.com"),
        "https://api.github.com",
        allowEnterprise,
        warnings,
      ),
      githubWebBaseUrl: githubBaseUrl(
        userValue(configuration, "github.webBaseUrl", "https://github.com"),
        "https://github.com",
        allowEnterprise,
        warnings,
      ),
      githubAllowEnterprise: allowEnterprise,
      githubCreateDraftPullRequest: value(configuration, "github.createDraftPullRequest", true),
      githubRequirePushConfirmation: true,
      githubRequirePullRequestConfirmation: true,
      githubRequireCommentConfirmation: true,
      githubRequireResolveThreadConfirmation: true,
      githubAllowLabelChanges: value(configuration, "github.allowLabelChanges", true),
      githubAllowIssueCreation: false,
      githubAllowIssueClosing: false,
      githubAllowReadyForReview: userValue(configuration, "github.allowReadyForReview", false),
      githubAllowMerge: false,
      githubAllowBranchDelete: false,
      githubAllowForcePush: false,
      githubCiPollingInterval: value(configuration, "github.ciPollingInterval", 30_000),
      githubCiMaxWait: value(configuration, "github.ciMaxWait", 1_800_000),
    };
    const settings = extensionSettingsSchema.parse({
      runtime,
      restartOnCrash: value(configuration, "runtime.restartOnCrash", true),
      showToolCalls: value(configuration, "ui.showToolCalls", true),
      showCommandOutput: value(configuration, "ui.showCommandOutput", false),
      compactMode: value(configuration, "ui.compactMode", false),
      historyEnabled: value(configuration, "history.enabled", true),
      historyMaxItems: value(configuration, "history.maxItems", 50),
      storeFullPrompts: false,
    });
    return { settings, warnings };
  }
}

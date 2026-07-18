import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { WorkspaceAccessError, WorkspaceNotFoundError } from "@local-code-agent/workspace";

import { ConfigurationError } from "./errors.js";

const DEFAULT_CONFIG = {
  ollamaHost: "http://127.0.0.1:11434",
  ollamaModel: "qwen3.5:9b",
  maxSteps: 20,
  contextLength: 32_768,
  temperature: 0.1,
  debug: false,
  workspace: ".",
  maxFileSizeBytes: 1_048_576,
  maxReadLines: 1_000,
  maxSearchResults: 100,
  maxDirectoryDepth: 12,
  includeHiddenFiles: false,
  respectGitignore: true,
  allowSensitiveFiles: false,
  maxToolResultChars: 50_000,
  accessMode: "preview" as const,
  requireWriteConfirmation: true,
  allowFileDelete: false,
  allowFileMove: true,
  defaultEol: "auto" as const,
  checkpointRetention: 20,
  checkpointMaxTotalBytes: 1_073_741_824,
  maxDiffChars: 100_000,
  maxChangedFiles: 30,
  maxCreatedFileBytes: 524_288,
  maxTotalWriteBytes: 5_242_880,
  maxPatchReplacements: 50,
  maxChangeOperations: 100,
  allowSensitiveFileWrite: false,
  allowSymlinkWrite: false,
  commandExecutionEnabled: true,
  commandPolicy: "verification" as const,
  commandTimeoutMs: 120_000,
  testTimeoutMs: 300_000,
  buildTimeoutMs: 300_000,
  maxCommandOutputChars: 100_000,
  maxCommandOutputLines: 5_000,
  maxCommandOutputBytes: 1_048_576,
  maxCommandsPerSession: 30,
  maxParallelCommands: 1,
  allowNetwork: false,
  allowPackageInstall: false,
  allowPackageScripts: true,
  allowCustomCommands: false,
  allowFormatCommands: true,
  allowEnvOverrides: false,
  allowedEnvVars: [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "TMPDIR",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "TERM",
  ],
  verificationEnabled: true,
  verificationBaseline: true,
  maxRepairAttempts: 3,
  verifyAfterApply: true,
  rollbackOnVerificationFailure: false,
  verificationScope: "affected_packages" as const,
  orchestrationEnabled: true,
  orchestrationModelDefault: "qwen3.5:9b",
  orchestrationModelPlanner: "qwen3.5:9b",
  orchestrationModelExplorer: "qwen2.5-coder:14b",
  orchestrationModelArchitect: "qwen3.5:9b",
  orchestrationModelImplementation: "qwen2.5-coder:14b",
  orchestrationModelTest: "qwen2.5-coder:14b",
  orchestrationModelReview: "qwen3.5:9b",
  orchestrationModelSecurity: "qwen3.5:9b",
  orchestrationModelPerformance: "qwen3.5:9b",
  orchestrationModelDocumentation: "qwen3.5:9b",
  orchestrationMaxAgents: 8,
  orchestrationMaxParallelAgents: 3,
  orchestrationMaxSubtasks: 30,
  orchestrationMaxDepth: 2,
  orchestrationMaxTotalSteps: 200,
  orchestrationMaxTotalToolCalls: 400,
  orchestrationMaxTotalCommands: 100,
  orchestrationMaxTotalDurationMs: 7_200_000,
  orchestrationMaxTotalContextTokens: 200_000,
  orchestrationMaxAgentContextTokens: 24_000,
  orchestrationMaxAgentOutputChars: 50_000,
  orchestrationRequirePlanApproval: true,
  orchestrationRequireFinalApproval: true,
  orchestrationRequireReview: true,
  orchestrationRequireSecurityReview: true,
  orchestrationAllowParallelWrites: false as const,
  orchestrationConsensusThreshold: 0.67,
  orchestrationStopOnCriticalSecurity: true,
  orchestrationMaxReplans: 3,
  orchestrationMaxTaskRetries: 2,
  remoteEnabled: false,
  remoteProvider: "github" as const,
  githubAuthMode: "vscode" as const,
  githubApiBaseUrl: "https://api.github.com",
  githubWebBaseUrl: "https://github.com",
  githubAllowEnterprise: false,
  githubAllowForkPublish: false,
  githubCreateDraftPr: true,
  githubRequirePushConfirmation: true,
  githubRequirePrConfirmation: true,
  githubRequireCommentConfirmation: true,
  githubRequireResolveThreadConfirmation: true,
  githubAllowLabelChanges: true,
  githubAllowAssigneeChanges: false,
  githubAllowMilestoneChanges: false,
  githubAllowIssueCreation: false as const,
  githubAllowIssueClosing: false as const,
  githubAllowPrReadyForReview: false,
  githubAllowPrMerge: false as const,
  githubAllowBranchDelete: false as const,
  githubAllowForcePush: false as const,
  githubMaxPrBodyChars: 50_000,
  githubMaxReviewComments: 200,
  githubMaxCiLogChars: 200_000,
  githubMaxApiRequestsPerSession: 200,
  githubRequestTimeoutMs: 60_000,
  githubCiPollIntervalMs: 30_000,
  githubCiMaxWaitMs: 1_800_000,
};

function booleanValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  if (value.toLowerCase() === "true") {
    return true;
  }

  if (value.toLowerCase() === "false") {
    return false;
  }

  return value;
}

const configSchema = z
  .object({
    ollamaHost: z
      .url("musi być poprawnym adresem URL")
      .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
        message: "musi używać protokołu http lub https",
      }),
    ollamaModel: z.string().trim().min(1, "nie może być pusty"),
    maxSteps: z.coerce.number().int().min(1).max(1_000),
    contextLength: z.coerce.number().int().min(1_024).max(2_000_000),
    temperature: z.coerce.number().min(0).max(2),
    debug: z.preprocess(booleanValue, z.boolean()),
    workspace: z.string().trim().min(1, "nie może być pusty"),
    maxFileSizeBytes: z.coerce.number().int().min(1).max(1_073_741_824),
    maxReadLines: z.coerce.number().int().min(1).max(100_000),
    maxSearchResults: z.coerce.number().int().min(1).max(10_000),
    maxDirectoryDepth: z.coerce.number().int().min(1).max(100),
    includeHiddenFiles: z.preprocess(booleanValue, z.boolean()),
    respectGitignore: z.preprocess(booleanValue, z.boolean()),
    allowSensitiveFiles: z.preprocess(booleanValue, z.boolean()),
    maxToolResultChars: z.coerce.number().int().min(1_000).max(1_000_000),
    accessMode: z.enum(["readonly", "preview", "write"]),
    requireWriteConfirmation: z.preprocess(booleanValue, z.boolean()),
    allowFileDelete: z.preprocess(booleanValue, z.boolean()),
    allowFileMove: z.preprocess(booleanValue, z.boolean()),
    defaultEol: z.enum(["auto", "lf", "crlf"]),
    checkpointRetention: z.coerce.number().int().min(1).max(1_000),
    checkpointMaxTotalBytes: z.coerce.number().int().min(1).max(1_099_511_627_776),
    maxDiffChars: z.coerce.number().int().min(1_000).max(10_000_000),
    maxChangedFiles: z.coerce.number().int().min(1).max(10_000),
    maxCreatedFileBytes: z.coerce.number().int().min(1).max(1_073_741_824),
    maxTotalWriteBytes: z.coerce.number().int().min(1).max(1_099_511_627_776),
    maxPatchReplacements: z.coerce.number().int().min(1).max(10_000),
    maxChangeOperations: z.coerce.number().int().min(1).max(10_000),
    allowSensitiveFileWrite: z.preprocess(booleanValue, z.boolean()),
    allowSymlinkWrite: z.preprocess(booleanValue, z.boolean()),
    commandExecutionEnabled: z.preprocess(booleanValue, z.boolean()),
    commandPolicy: z.enum(["disabled", "verification", "restricted", "custom"]),
    commandTimeoutMs: z.coerce.number().int().min(1_000).max(3_600_000),
    testTimeoutMs: z.coerce.number().int().min(1_000).max(3_600_000),
    buildTimeoutMs: z.coerce.number().int().min(1_000).max(3_600_000),
    maxCommandOutputChars: z.coerce.number().int().min(1_000).max(10_000_000),
    maxCommandOutputLines: z.coerce.number().int().min(10).max(1_000_000),
    maxCommandOutputBytes: z.coerce.number().int().min(1_024).max(100_000_000),
    maxCommandsPerSession: z.coerce.number().int().min(1).max(1_000),
    maxParallelCommands: z.coerce.number().int().min(1).max(16),
    allowNetwork: z.preprocess(booleanValue, z.boolean()),
    allowPackageInstall: z.preprocess(booleanValue, z.boolean()),
    allowPackageScripts: z.preprocess(booleanValue, z.boolean()),
    allowCustomCommands: z.preprocess(booleanValue, z.boolean()),
    allowFormatCommands: z.preprocess(booleanValue, z.boolean()),
    allowEnvOverrides: z.preprocess(booleanValue, z.boolean()),
    allowedEnvVars: z.preprocess(
      (value) =>
        typeof value === "string"
          ? value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean)
          : value,
      z.array(z.string().trim().min(1)).min(1).max(100),
    ),
    verificationEnabled: z.preprocess(booleanValue, z.boolean()),
    verificationBaseline: z.preprocess(booleanValue, z.boolean()),
    maxRepairAttempts: z.coerce.number().int().min(0).max(20),
    verifyAfterApply: z.preprocess(booleanValue, z.boolean()),
    rollbackOnVerificationFailure: z.preprocess(booleanValue, z.boolean()),
    verificationScope: z.enum(["changed_files", "affected_packages", "workspace"]),
    orchestrationEnabled: z.preprocess(booleanValue, z.boolean()),
    orchestrationModelDefault: z.string().trim().min(1),
    orchestrationModelPlanner: z.string().trim().min(1),
    orchestrationModelExplorer: z.string().trim().min(1),
    orchestrationModelArchitect: z.string().trim().min(1),
    orchestrationModelImplementation: z.string().trim().min(1),
    orchestrationModelTest: z.string().trim().min(1),
    orchestrationModelReview: z.string().trim().min(1),
    orchestrationModelSecurity: z.string().trim().min(1),
    orchestrationModelPerformance: z.string().trim().min(1),
    orchestrationModelDocumentation: z.string().trim().min(1),
    orchestrationMaxAgents: z.coerce.number().int().min(1).max(64),
    orchestrationMaxParallelAgents: z.coerce.number().int().min(1).max(16),
    orchestrationMaxSubtasks: z.coerce.number().int().min(1).max(500),
    orchestrationMaxDepth: z.coerce.number().int().min(1).max(16),
    orchestrationMaxTotalSteps: z.coerce.number().int().min(1).max(100_000),
    orchestrationMaxTotalToolCalls: z.coerce.number().int().min(1).max(100_000),
    orchestrationMaxTotalCommands: z.coerce.number().int().min(0).max(10_000),
    orchestrationMaxTotalDurationMs: z.coerce.number().int().min(1_000).max(86_400_000),
    orchestrationMaxTotalContextTokens: z.coerce.number().int().min(1_000).max(10_000_000),
    orchestrationMaxAgentContextTokens: z.coerce.number().int().min(1_000).max(2_000_000),
    orchestrationMaxAgentOutputChars: z.coerce.number().int().min(1_000).max(1_000_000),
    orchestrationRequirePlanApproval: z.preprocess(booleanValue, z.boolean()),
    orchestrationRequireFinalApproval: z.preprocess(booleanValue, z.boolean()),
    orchestrationRequireReview: z.preprocess(booleanValue, z.boolean()),
    orchestrationRequireSecurityReview: z.preprocess(booleanValue, z.boolean()),
    orchestrationAllowParallelWrites: z.preprocess(booleanValue, z.literal(false)),
    orchestrationConsensusThreshold: z.coerce.number().min(0.5).max(1),
    orchestrationStopOnCriticalSecurity: z.preprocess(booleanValue, z.boolean()),
    orchestrationMaxReplans: z.coerce.number().int().min(0).max(20),
    orchestrationMaxTaskRetries: z.coerce.number().int().min(0).max(10),
    remoteEnabled: z.preprocess(booleanValue, z.boolean()),
    remoteProvider: z.literal("github"),
    githubAuthMode: z.enum(["vscode", "token"]),
    githubApiBaseUrl: z.url().refine((value) => value.startsWith("https://"), "musi używać HTTPS"),
    githubWebBaseUrl: z.url().refine((value) => value.startsWith("https://"), "musi używać HTTPS"),
    githubAllowEnterprise: z.preprocess(booleanValue, z.boolean()),
    githubAllowForkPublish: z.preprocess(booleanValue, z.boolean()),
    githubCreateDraftPr: z.preprocess(booleanValue, z.boolean()),
    githubRequirePushConfirmation: z.preprocess(booleanValue, z.boolean()),
    githubRequirePrConfirmation: z.preprocess(booleanValue, z.boolean()),
    githubRequireCommentConfirmation: z.preprocess(booleanValue, z.boolean()),
    githubRequireResolveThreadConfirmation: z.preprocess(booleanValue, z.boolean()),
    githubAllowLabelChanges: z.preprocess(booleanValue, z.boolean()),
    githubAllowAssigneeChanges: z.preprocess(booleanValue, z.boolean()),
    githubAllowMilestoneChanges: z.preprocess(booleanValue, z.boolean()),
    githubAllowIssueCreation: z.preprocess(booleanValue, z.literal(false)),
    githubAllowIssueClosing: z.preprocess(booleanValue, z.literal(false)),
    githubAllowPrReadyForReview: z.preprocess(booleanValue, z.boolean()),
    githubAllowPrMerge: z.preprocess(booleanValue, z.literal(false)),
    githubAllowBranchDelete: z.preprocess(booleanValue, z.literal(false)),
    githubAllowForcePush: z.preprocess(booleanValue, z.literal(false)),
    githubMaxPrBodyChars: z.coerce.number().int().min(1_000).max(100_000),
    githubMaxReviewComments: z.coerce.number().int().min(1).max(500),
    githubMaxCiLogChars: z.coerce.number().int().min(1_000).max(1_000_000),
    githubMaxApiRequestsPerSession: z.coerce.number().int().min(1).max(10_000),
    githubRequestTimeoutMs: z.coerce.number().int().min(1_000).max(300_000),
    githubCiPollIntervalMs: z.coerce.number().int().min(10_000).max(600_000),
    githubCiMaxWaitMs: z.coerce.number().int().min(10_000).max(7_200_000),
  })
  .strict();

export type AgentConfig = z.infer<typeof configSchema>;

export interface LoadConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: Partial<AgentConfig>;
}

function environmentOverrides(env: NodeJS.ProcessEnv): Partial<Record<keyof AgentConfig, unknown>> {
  const result: Partial<Record<keyof AgentConfig, unknown>> = {};
  const mappings: ReadonlyArray<[keyof AgentConfig, string]> = [
    ["ollamaHost", "OLLAMA_HOST"],
    ["ollamaModel", "OLLAMA_MODEL"],
    ["maxSteps", "AGENT_MAX_STEPS"],
    ["contextLength", "AGENT_CONTEXT_LENGTH"],
    ["temperature", "AGENT_TEMPERATURE"],
    ["debug", "AGENT_DEBUG"],
    ["workspace", "AGENT_WORKSPACE"],
    ["maxFileSizeBytes", "AGENT_MAX_FILE_SIZE_BYTES"],
    ["maxReadLines", "AGENT_MAX_READ_LINES"],
    ["maxSearchResults", "AGENT_MAX_SEARCH_RESULTS"],
    ["maxDirectoryDepth", "AGENT_MAX_DIRECTORY_DEPTH"],
    ["includeHiddenFiles", "AGENT_INCLUDE_HIDDEN_FILES"],
    ["respectGitignore", "AGENT_RESPECT_GITIGNORE"],
    ["allowSensitiveFiles", "AGENT_ALLOW_SENSITIVE_FILES"],
    ["maxToolResultChars", "AGENT_MAX_TOOL_RESULT_CHARS"],
    ["accessMode", "AGENT_ACCESS_MODE"],
    ["requireWriteConfirmation", "AGENT_REQUIRE_WRITE_CONFIRMATION"],
    ["allowFileDelete", "AGENT_ALLOW_FILE_DELETE"],
    ["allowFileMove", "AGENT_ALLOW_FILE_MOVE"],
    ["defaultEol", "AGENT_DEFAULT_EOL"],
    ["checkpointRetention", "AGENT_CHECKPOINT_RETENTION"],
    ["checkpointMaxTotalBytes", "AGENT_CHECKPOINT_MAX_TOTAL_BYTES"],
    ["maxDiffChars", "AGENT_MAX_DIFF_CHARS"],
    ["maxChangedFiles", "AGENT_MAX_CHANGED_FILES"],
    ["maxCreatedFileBytes", "AGENT_MAX_CREATED_FILE_BYTES"],
    ["maxTotalWriteBytes", "AGENT_MAX_TOTAL_WRITE_BYTES"],
    ["maxPatchReplacements", "AGENT_MAX_PATCH_REPLACEMENTS"],
    ["maxChangeOperations", "AGENT_MAX_CHANGE_OPERATIONS"],
    ["allowSensitiveFileWrite", "AGENT_ALLOW_SENSITIVE_FILE_WRITE"],
    ["allowSymlinkWrite", "AGENT_ALLOW_SYMLINK_WRITE"],
    ["commandExecutionEnabled", "AGENT_COMMAND_EXECUTION_ENABLED"],
    ["commandPolicy", "AGENT_COMMAND_POLICY"],
    ["commandTimeoutMs", "AGENT_COMMAND_TIMEOUT_MS"],
    ["testTimeoutMs", "AGENT_TEST_TIMEOUT_MS"],
    ["buildTimeoutMs", "AGENT_BUILD_TIMEOUT_MS"],
    ["maxCommandOutputChars", "AGENT_MAX_COMMAND_OUTPUT_CHARS"],
    ["maxCommandOutputLines", "AGENT_MAX_COMMAND_OUTPUT_LINES"],
    ["maxCommandOutputBytes", "AGENT_MAX_COMMAND_OUTPUT_BYTES"],
    ["maxCommandsPerSession", "AGENT_MAX_COMMANDS_PER_SESSION"],
    ["maxParallelCommands", "AGENT_MAX_PARALLEL_COMMANDS"],
    ["allowNetwork", "AGENT_ALLOW_NETWORK"],
    ["allowPackageInstall", "AGENT_ALLOW_PACKAGE_INSTALL"],
    ["allowPackageScripts", "AGENT_ALLOW_PACKAGE_SCRIPTS"],
    ["allowCustomCommands", "AGENT_ALLOW_CUSTOM_COMMANDS"],
    ["allowFormatCommands", "AGENT_ALLOW_FORMAT_COMMANDS"],
    ["allowEnvOverrides", "AGENT_ALLOW_ENV_OVERRIDES"],
    ["allowedEnvVars", "AGENT_ALLOWED_ENV_VARS"],
    ["verificationEnabled", "AGENT_VERIFICATION_ENABLED"],
    ["verificationBaseline", "AGENT_VERIFICATION_BASELINE"],
    ["maxRepairAttempts", "AGENT_MAX_REPAIR_ATTEMPTS"],
    ["verifyAfterApply", "AGENT_VERIFY_AFTER_APPLY"],
    ["rollbackOnVerificationFailure", "AGENT_ROLLBACK_ON_VERIFICATION_FAILURE"],
    ["verificationScope", "AGENT_VERIFICATION_SCOPE"],
    ["orchestrationEnabled", "AGENT_ORCHESTRATION_ENABLED"],
    ["orchestrationModelDefault", "AGENT_ORCHESTRATION_MODEL_DEFAULT"],
    ["orchestrationModelPlanner", "AGENT_ORCHESTRATION_MODEL_PLANNER"],
    ["orchestrationModelExplorer", "AGENT_ORCHESTRATION_MODEL_EXPLORER"],
    ["orchestrationModelArchitect", "AGENT_ORCHESTRATION_MODEL_ARCHITECT"],
    ["orchestrationModelImplementation", "AGENT_ORCHESTRATION_MODEL_IMPLEMENTATION"],
    ["orchestrationModelTest", "AGENT_ORCHESTRATION_MODEL_TEST"],
    ["orchestrationModelReview", "AGENT_ORCHESTRATION_MODEL_REVIEW"],
    ["orchestrationModelSecurity", "AGENT_ORCHESTRATION_MODEL_SECURITY"],
    ["orchestrationModelPerformance", "AGENT_ORCHESTRATION_MODEL_PERFORMANCE"],
    ["orchestrationModelDocumentation", "AGENT_ORCHESTRATION_MODEL_DOCUMENTATION"],
    ["orchestrationMaxAgents", "AGENT_ORCHESTRATION_MAX_AGENTS"],
    ["orchestrationMaxParallelAgents", "AGENT_ORCHESTRATION_MAX_PARALLEL_AGENTS"],
    ["orchestrationMaxSubtasks", "AGENT_ORCHESTRATION_MAX_SUBTASKS"],
    ["orchestrationMaxDepth", "AGENT_ORCHESTRATION_MAX_DEPTH"],
    ["orchestrationMaxTotalSteps", "AGENT_ORCHESTRATION_MAX_TOTAL_STEPS"],
    ["orchestrationMaxTotalToolCalls", "AGENT_ORCHESTRATION_MAX_TOTAL_TOOL_CALLS"],
    ["orchestrationMaxTotalCommands", "AGENT_ORCHESTRATION_MAX_TOTAL_COMMANDS"],
    ["orchestrationMaxTotalDurationMs", "AGENT_ORCHESTRATION_MAX_TOTAL_DURATION_MS"],
    ["orchestrationMaxTotalContextTokens", "AGENT_ORCHESTRATION_MAX_TOTAL_CONTEXT_TOKENS"],
    ["orchestrationMaxAgentContextTokens", "AGENT_ORCHESTRATION_MAX_AGENT_CONTEXT_TOKENS"],
    ["orchestrationMaxAgentOutputChars", "AGENT_ORCHESTRATION_MAX_AGENT_OUTPUT_CHARS"],
    ["orchestrationRequirePlanApproval", "AGENT_ORCHESTRATION_REQUIRE_PLAN_APPROVAL"],
    ["orchestrationRequireFinalApproval", "AGENT_ORCHESTRATION_REQUIRE_FINAL_APPROVAL"],
    ["orchestrationRequireReview", "AGENT_ORCHESTRATION_REQUIRE_REVIEW"],
    ["orchestrationRequireSecurityReview", "AGENT_ORCHESTRATION_REQUIRE_SECURITY_REVIEW"],
    ["orchestrationAllowParallelWrites", "AGENT_ORCHESTRATION_ALLOW_PARALLEL_WRITES"],
    ["orchestrationConsensusThreshold", "AGENT_ORCHESTRATION_CONSENSUS_THRESHOLD"],
    ["orchestrationStopOnCriticalSecurity", "AGENT_ORCHESTRATION_STOP_ON_CRITICAL_SECURITY"],
    ["orchestrationMaxReplans", "AGENT_ORCHESTRATION_MAX_REPLANS"],
    ["orchestrationMaxTaskRetries", "AGENT_ORCHESTRATION_MAX_TASK_RETRIES"],
    ["remoteEnabled", "AGENT_REMOTE_ENABLED"],
    ["remoteProvider", "AGENT_REMOTE_PROVIDER"],
    ["githubAuthMode", "AGENT_GITHUB_AUTH_MODE"],
    ["githubApiBaseUrl", "AGENT_GITHUB_API_BASE_URL"],
    ["githubWebBaseUrl", "AGENT_GITHUB_WEB_BASE_URL"],
    ["githubAllowEnterprise", "AGENT_GITHUB_ALLOW_ENTERPRISE"],
    ["githubAllowForkPublish", "AGENT_GITHUB_ALLOW_FORK_PUBLISH"],
    ["githubCreateDraftPr", "AGENT_GITHUB_CREATE_DRAFT_PR"],
    ["githubRequirePushConfirmation", "AGENT_GITHUB_REQUIRE_PUSH_CONFIRMATION"],
    ["githubRequirePrConfirmation", "AGENT_GITHUB_REQUIRE_PR_CONFIRMATION"],
    ["githubRequireCommentConfirmation", "AGENT_GITHUB_REQUIRE_COMMENT_CONFIRMATION"],
    ["githubRequireResolveThreadConfirmation", "AGENT_GITHUB_REQUIRE_RESOLVE_THREAD_CONFIRMATION"],
    ["githubAllowLabelChanges", "AGENT_GITHUB_ALLOW_LABEL_CHANGES"],
    ["githubAllowAssigneeChanges", "AGENT_GITHUB_ALLOW_ASSIGNEE_CHANGES"],
    ["githubAllowMilestoneChanges", "AGENT_GITHUB_ALLOW_MILESTONE_CHANGES"],
    ["githubAllowIssueCreation", "AGENT_GITHUB_ALLOW_ISSUE_CREATION"],
    ["githubAllowIssueClosing", "AGENT_GITHUB_ALLOW_ISSUE_CLOSING"],
    ["githubAllowPrReadyForReview", "AGENT_GITHUB_ALLOW_PR_READY_FOR_REVIEW"],
    ["githubAllowPrMerge", "AGENT_GITHUB_ALLOW_PR_MERGE"],
    ["githubAllowBranchDelete", "AGENT_GITHUB_ALLOW_BRANCH_DELETE"],
    ["githubAllowForcePush", "AGENT_GITHUB_ALLOW_FORCE_PUSH"],
    ["githubMaxPrBodyChars", "AGENT_GITHUB_MAX_PR_BODY_CHARS"],
    ["githubMaxReviewComments", "AGENT_GITHUB_MAX_REVIEW_COMMENTS"],
    ["githubMaxCiLogChars", "AGENT_GITHUB_MAX_CI_LOG_CHARS"],
    ["githubMaxApiRequestsPerSession", "AGENT_GITHUB_MAX_API_REQUESTS_PER_SESSION"],
    ["githubRequestTimeoutMs", "AGENT_GITHUB_REQUEST_TIMEOUT_MS"],
    ["githubCiPollIntervalMs", "AGENT_GITHUB_CI_POLL_INTERVAL_MS"],
    ["githubCiMaxWaitMs", "AGENT_GITHUB_CI_MAX_WAIT_MS"],
  ];

  for (const [field, variable] of mappings) {
    const value = env[variable];
    if (value !== undefined) {
      result[field] = value;
    }
  }

  return result;
}

async function readConfigFile(path: string): Promise<unknown> {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as unknown;
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

    if (code === "ENOENT") {
      return {};
    }

    const details = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Nie można odczytać konfiguracji z ${path}: ${details}`);
  }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AgentConfig> {
  const env = options.env ?? process.env;
  const invocationDirectory = env.INIT_CWD ?? process.cwd();
  const configPath = options.configPath ?? resolve(invocationDirectory, "config", "default.json");
  const fromFile = await readConfigFile(configPath);

  if (typeof fromFile !== "object" || fromFile === null || Array.isArray(fromFile)) {
    throw new ConfigurationError(`Plik ${configPath} musi zawierać obiekt JSON.`);
  }

  const parsed = configSchema.safeParse({
    ...DEFAULT_CONFIG,
    ...fromFile,
    ...environmentOverrides(env),
    ...options.overrides,
  });

  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "konfiguracja"}: ${issue.message}`)
      .join("\n");
    throw new ConfigurationError(`Nieprawidłowa konfiguracja:\n${fields}`, parsed.error.issues);
  }

  const api = new URL(parsed.data.githubApiBaseUrl);
  const web = new URL(parsed.data.githubWebBaseUrl);
  if (
    !parsed.data.githubAllowEnterprise &&
    (api.origin !== "https://api.github.com" || web.origin !== "https://github.com")
  ) {
    throw new ConfigurationError(
      "Niestandardowe adresy GitHub wymagają AGENT_GITHUB_ALLOW_ENTERPRISE=true.",
    );
  }

  const absoluteWorkspace = resolve(invocationDirectory, parsed.data.workspace);
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = await realpath(absoluteWorkspace);
  } catch (error: unknown) {
    throw new WorkspaceNotFoundError(absoluteWorkspace, { cause: error });
  }
  try {
    const workspaceStats = await stat(canonicalWorkspace);
    if (!workspaceStats.isDirectory()) {
      throw new WorkspaceAccessError("Skonfigurowany workspace nie jest katalogiem.");
    }
    await access(canonicalWorkspace, constants.R_OK);
  } catch (error: unknown) {
    if (error instanceof WorkspaceAccessError) throw error;
    throw new WorkspaceAccessError("Skonfigurowany workspace nie jest możliwy do odczytu.", {
      cause: error,
    });
  }

  return { ...parsed.data, workspace: canonicalWorkspace };
}

export function isDebugRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_DEBUG?.toLowerCase() === "true";
}

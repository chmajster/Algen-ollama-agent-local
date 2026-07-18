import { EnvironmentVariableBlockedError } from "./errors.js";

const SECRET_PATTERNS = [
  /^AWS_/iu,
  /^TF_TOKEN_/iu,
  /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH_SOCK|KUBECONFIG|OPENAI_API_KEY|ANTHROPIC_API_KEY)/iu,
  /^DOCKER_AUTH_CONFIG$/iu,
  /^GOOGLE_APPLICATION_CREDENTIALS$/iu,
];

const SAFE_RUNTIME_OVERRIDES = new Set([
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "GOPROXY",
  "GONOSUMDB",
  "NPM_CONFIG_OFFLINE",
  "YARN_ENABLE_NETWORK",
  "PIP_NO_INDEX",
  "CARGO_NET_OFFLINE",
  "COMPOSER_DISABLE_NETWORK",
  "DOTNET_NOLOGO",
]);

export interface EnvironmentSanitizerOptions {
  allowedVariables: string[];
  allowOverrides: boolean;
}

export class EnvironmentSanitizer {
  private readonly allowed: Set<string>;

  public constructor(private readonly options: EnvironmentSanitizerOptions) {
    this.allowed = new Set(options.allowedVariables.map((value) => value.toUpperCase()));
  }

  public sanitize(
    source: NodeJS.ProcessEnv = process.env,
    overrides: Readonly<Record<string, string>> = {},
  ): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || SECRET_PATTERNS.some((pattern) => pattern.test(key))) continue;
      if (this.allowed.has(key.toUpperCase())) result[key] = value;
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (SECRET_PATTERNS.some((pattern) => pattern.test(key))) {
        throw new EnvironmentVariableBlockedError(undefined, { variable: key });
      }
      if (!this.options.allowOverrides && !SAFE_RUNTIME_OVERRIDES.has(key.toUpperCase())) {
        throw new EnvironmentVariableBlockedError(undefined, { variable: key });
      }
      if (!this.allowed.has(key.toUpperCase()) && !SAFE_RUNTIME_OVERRIDES.has(key.toUpperCase())) {
        throw new EnvironmentVariableBlockedError(undefined, { variable: key });
      }
      result[key] = value;
    }
    return result;
  }
}

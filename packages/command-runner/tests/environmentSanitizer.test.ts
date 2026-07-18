import { describe, expect, it } from "vitest";

import { EnvironmentSanitizer, EnvironmentVariableBlockedError } from "../src/index.js";

function sanitizer(allowOverrides = false) {
  return new EnvironmentSanitizer({
    allowedVariables: ["PATH", "HOME", "USERPROFILE", "TEMP", "SystemRoot", "LANG"],
    allowOverrides,
  });
}

describe("EnvironmentSanitizer", () => {
  it("zachowuje PATH i podstawowe dozwolone zmienne", () => {
    expect(sanitizer().sanitize({ PATH: "bin", HOME: "/home", LANG: "pl" })).toEqual({
      PATH: "bin",
      HOME: "/home",
      LANG: "pl",
    });
  });

  it.each([
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "SSH_AUTH_SOCK",
    "OPENAI_API_KEY",
    "DOCKER_AUTH_CONFIG",
    "TF_TOKEN_app",
  ])("usuwa sekret %s", (key) => {
    expect(sanitizer().sanitize({ PATH: "bin", [key]: "secret" })).toEqual({ PATH: "bin" });
  });

  it("nie kopiuje zmiennej spoza allowlisty", () => {
    expect(sanitizer().sanitize({ PATH: "bin", RANDOM_VALUE: "x" })).not.toHaveProperty(
      "RANDOM_VALUE",
    );
  });

  it("blokuje własny override przy wyłączonej opcji", () => {
    expect(() => sanitizer().sanitize({ PATH: "bin" }, { HOME: "/other" })).toThrow(
      EnvironmentVariableBlockedError,
    );
  });

  it("dopuszcza wewnętrzne CI i NO_COLOR", () => {
    expect(sanitizer().sanitize({ PATH: "bin" }, { CI: "true", NO_COLOR: "1" })).toMatchObject({
      CI: "true",
      NO_COLOR: "1",
    });
  });

  it("dopuszcza jawny override dozwolonej zmiennej", () => {
    expect(sanitizer(true).sanitize({ PATH: "old" }, { PATH: "new" }).PATH).toBe("new");
  });

  it("nadal blokuje sekret przy włączonych override", () => {
    expect(() => sanitizer(true).sanitize({}, { NPM_TOKEN: "secret" })).toThrow(
      EnvironmentVariableBlockedError,
    );
  });
});

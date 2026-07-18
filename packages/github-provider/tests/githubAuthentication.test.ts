import { describe, expect, it } from "vitest";

import { GitHubAuthentication, GitHubTokenMissingError } from "../src/index.js";

describe("GitHub authentication", () => {
  it("keeps a VS Code token only in memory", () => {
    const auth = new GitHubAuthentication();
    auth.connect("github_pat_abcdefghijklmnopqrstuvwxyz", "vscode");
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.getSource()).toBe("vscode");
  });

  it.each([
    ["GITHUB_TOKEN", { GITHUB_TOKEN: "token-one", GH_TOKEN: "token-two" }, "token-one"],
    ["GH_TOKEN", { GH_TOKEN: "token-two" }, "token-two"],
  ] as const)("uses %s", async (source, env, token) => {
    const auth = new GitHubAuthentication();
    expect(await auth.connectFromEnvironment(env)).toBe(source);
    expect(auth.getToken()).toBe(token);
  });

  it("uses a credential store", async () => {
    const auth = new GitHubAuthentication();
    expect(await auth.connectFromEnvironment({}, { get: async () => "stored-token" })).toBe(
      "credential_store",
    );
  });

  it("fails when token is missing", async () => {
    await expect(new GitHubAuthentication().connectFromEnvironment({})).rejects.toThrow(
      GitHubTokenMissingError,
    );
  });

  it("disconnects and removes the memory token", () => {
    const auth = new GitHubAuthentication();
    auth.connect("token", "vscode");
    auth.disconnect();
    expect(auth.isAuthenticated()).toBe(false);
    expect(() => auth.getToken()).toThrow(GitHubTokenMissingError);
  });

  it("does not expose token through JSON serialization", () => {
    const auth = new GitHubAuthentication();
    auth.connect("secret-token", "vscode");
    expect(JSON.stringify(auth)).not.toContain("secret-token");
  });
});

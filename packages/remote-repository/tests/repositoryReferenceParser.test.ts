import { describe, expect, it } from "vitest";

import {
  RemoteRepositoryAmbiguousError,
  RemoteRepositoryHostBlockedError,
  RemoteRepositoryNotFoundError,
  parseRepositoryReference,
  remoteUrlContainsCredentials,
  resolveRepositoryReference,
  sanitizeRemoteUrl,
} from "../src/index.js";

describe("repository reference parser", () => {
  it.each([
    ["SSH GitHub", "git@github.com:owner/repository.git", "ssh"],
    ["HTTPS GitHub", "https://github.com/owner/repository.git", "https"],
    ["SSH URL", "ssh://git@github.com/owner/repository.git", "ssh"],
  ] as const)("parses %s", (_name, url, type) => {
    expect(parseRepositoryReference({ name: "origin", url })).toMatchObject({
      host: "github.com",
      owner: "owner",
      repository: "repository",
      remoteName: "origin",
      remoteUrlType: type,
    });
  });

  it("blocks another host", () => {
    expect(() =>
      parseRepositoryReference({ name: "origin", url: "https://gitlab.com/o/r.git" }),
    ).toThrow(RemoteRepositoryHostBlockedError);
  });

  it("requires a choice for multiple remotes", () => {
    expect(() =>
      resolveRepositoryReference([
        { name: "origin", url: "https://github.com/a/r.git" },
        { name: "upstream", url: "https://github.com/b/r.git" },
      ]),
    ).toThrow(RemoteRepositoryAmbiguousError);
  });

  it("rejects no remotes", () =>
    expect(() => resolveRepositoryReference([])).toThrow(RemoteRepositoryNotFoundError));

  it("rejects a credential URL and sanitizes it", () => {
    const value = "https://user:secret@github.com/owner/repository.git";
    expect(remoteUrlContainsCredentials(value)).toBe(true);
    expect(() => parseRepositoryReference({ name: "origin", url: value })).toThrow(
      RemoteRepositoryHostBlockedError,
    );
    expect(sanitizeRemoteUrl(value)).not.toContain("secret");
  });

  it.each([
    ["invalid owner", "https://github.com/-owner/repository.git"],
    ["invalid repository", "https://github.com/owner/../repository.git"],
  ])("rejects %s", (_name, url) => {
    expect(() => parseRepositoryReference({ name: "origin", url })).toThrow();
  });

  it("allows an explicitly configured enterprise host", () => {
    expect(
      parseRepositoryReference(
        { name: "origin", url: "https://github.example.com/owner/repository.git" },
        { expectedHost: "github.example.com", allowEnterprise: true },
      ).host,
    ).toBe("github.example.com");
  });
});

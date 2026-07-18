import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { loadTaskManifest, saveTaskManifest, type GitHubTaskManifest } from "../src/index.js";

async function fixture(overrides: Partial<GitHubTaskManifest> = {}) {
  const root = await mkdtemp(join(tmpdir(), "github-task-"));
  const taskId = "task-20260716-test";
  const directory = join(root, ".agent", "tasks", taskId);
  await mkdir(directory, { recursive: true });
  const manifest: GitHubTaskManifest = {
    id: taskId,
    branch: "agent/20260716/test/change",
    baseBranch: "main",
    workspacePath: root,
    status: "completed",
    finalReview: { completed: true },
    commits: [{ sha: "a".repeat(40), subject: "feat: change" }],
    ...overrides,
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest), "utf8");
  return { root, taskId, manifest };
}

describe("task publication manifest", () => {
  it("loads a completed reviewed task branch", async () => {
    const value = await fixture();
    expect(await loadTaskManifest(value.root, value.taskId)).toMatchObject({
      id: value.taskId,
      status: "completed",
    });
  });

  it.each([
    ["main branch", { branch: "main" }],
    ["dirty status", { status: "failed" as const }],
    ["missing final review", { finalReview: { completed: false } }],
    ["missing commits", { commits: [] }],
    ["unrelated branch", { branch: "feature/not-a-task" }],
  ])("blocks %s", async (_name, overrides) => {
    const value = await fixture(overrides);
    await expect(loadTaskManifest(value.root, value.taskId)).rejects.toThrow();
  });

  it("rejects traversal in task id", async () => {
    await expect(loadTaskManifest(".", "../secret")).rejects.toThrow();
  });

  it("persists remote state without a token", async () => {
    const value = await fixture();
    value.manifest.remote = {
      provider: "github",
      repository: { host: "github.com", owner: "owner", name: "repo", remoteName: "origin" },
      publishedBranch: {
        name: value.manifest.branch,
        remoteHead: "a".repeat(40),
        publishedAt: new Date(0).toISOString(),
      },
    };
    await saveTaskManifest(value.root, value.manifest);
    const content = await readFile(
      join(value.root, ".agent", "tasks", value.taskId, "manifest.json"),
      "utf8",
    );
    expect(content).toContain("publishedBranch");
    expect(content).not.toMatch(/token|authorization/i);
  });
});

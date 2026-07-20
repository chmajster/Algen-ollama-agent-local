import { describe, expect, it } from "vitest";

import { viewStateSchema, webviewToHostSchema } from "../../src/webview/messages.js";
import {
  mapChanges,
  mapCheckpoints,
  mapGitHub,
  mapHistory,
  mapOrchestration,
  mapVerification,
} from "../../src/webview/presentationModels.js";
import {
  canSubmit,
  filterHistory,
  historyEmptyLabel,
  shouldSubmitKey,
  updateUiState,
} from "../../src/webview/uiModel.js";

describe("WebView messages and UI state", () => {
  it("validates typed actions and rejects extra data", () => {
    expect(webviewToHostSchema.safeParse({ type: "diff.open", path: "src/a.ts" }).success).toBe(true);
    expect(webviewToHostSchema.safeParse({ type: "changes.apply", unsafe: true }).success).toBe(false);
  });

  it("keeps the draft while switching tabs", () => {
    const initial = { activeTab: "tasks" as const, draft: "napraw test", taskFilter: "" };
    expect(updateUiState(initial, { activeTab: "changes" })).toEqual({
      activeTab: "changes",
      draft: "napraw test",
      taskFilter: "",
    });
  });

  it("submits Enter but preserves Shift+Enter for a new line", () => {
    expect(shouldSubmitKey("Enter", false)).toBe(true);
    expect(shouldSubmitKey("Enter", true)).toBe(false);
  });

  it("disables submission for unavailable runtime and blank drafts", () => {
    expect(canSubmit("ready", "zadanie")).toBe(true);
    expect(canSubmit("ready", "  ")).toBe(false);
    expect(canSubmit("stopped", "zadanie")).toBe(false);
  });
});

describe("presentation mappings", () => {
  it("maps history, filtering and empty states", () => {
    const history = mapHistory([{ id: "1", createdAt: "2026-01-01T00:00:00Z", promptSummary: "Napraw lint", mode: "agent", status: "completed", filesChanged: 2 }]);
    expect(history[0]).toMatchObject({ title: "Napraw lint", filesChanged: 2 });
    expect(filterHistory(history, "LINT")).toHaveLength(1);
    expect(historyEmptyLabel("")).toBe("Brak zadań");
    expect(historyEmptyLabel("x")).toBe("Brak pasujących zadań");
  });

  it("maps changes and checkpoints without exposing raw payloads", () => {
    expect(mapChanges({ operations: [{ id: "a", type: "create_file", path: "a.ts", reason: "new" }] })).toEqual([{ id: "a", path: "a.ts", operation: "create", reason: "new" }]);
    expect(mapCheckpoints([{ id: "abcdef123", task: "Task", createdAt: "2026-01-01" }])).toEqual([{ id: "abcdef123", task: "Task", createdAt: "2026-01-01" }]);
  });

  it("does not report missing verification steps as success", () => {
    expect(mapVerification({ status: "passed", steps: [] })).toMatchObject({ status: "not-run", passed: 0, failed: 0, steps: [] });
    expect(mapVerification({ status: "failed", durationMs: 10, steps: [{ commandId: "lint", displayName: "Lint", status: "failed", stderr: "bad" }] })).toMatchObject({ failed: 1, steps: [{ kind: "lint", details: "bad" }] });
  });

  it("maps orchestration approvals, security and GitHub status", () => {
    expect(mapOrchestration({ session: { id: "s", state: "awaiting_plan_approval", mode: "analysis" }, graph: { nodes: [{ id: "n", title: "Plan", status: "pending" }] }, agents: [{ id: "a", role: "reviewer", status: "created" }], review: { status: "security_blocked" } })).toMatchObject({ requiresAction: true, securityBlocked: true, agents: [{ title: "reviewer" }], tasks: [{ title: "Plan" }] });
    expect(mapGitHub({ enabled: true, user: { login: "octo" }, repository: { owner: "o", repository: "r" }, permissions: { write: true } })).toMatchObject({ connected: true, account: "octo", repository: "o/r", permission: "write" });
  });

  it("accepts only the bounded combined view state", () => {
    const state = { runtimeState: "stopped", mode: "ask", context: "none", workspaceLabel: "repo", trusted: true, task: null, messages: [], history: [], changes: [], checkpoints: [], verification: null, orchestration: null, github: { enabled: false, connected: false, permission: "unknown" }, error: null };
    expect(viewStateSchema.safeParse(state).success).toBe(true);
    expect(viewStateSchema.safeParse({ ...state, secret: "token" }).success).toBe(false);
  });
});

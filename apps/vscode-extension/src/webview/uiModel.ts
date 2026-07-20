import type { AgentViewState, TabId } from "./messages.js";

export interface PersistedUiState {
  activeTab: TabId;
  draft: string;
  taskFilter: string;
}

export function updateUiState(
  previous: PersistedUiState,
  update: Partial<PersistedUiState>,
): PersistedUiState {
  return { ...previous, ...update };
}

export function shouldSubmitKey(key: string, shiftKey: boolean): boolean {
  return key === "Enter" && !shiftKey;
}

export function canSubmit(runtimeState: AgentViewState["runtimeState"], draft: string): boolean {
  return runtimeState === "ready" && draft.trim() !== "";
}

export function filterHistory(
  history: AgentViewState["history"],
  query: string,
): AgentViewState["history"] {
  const normalized = query.trim().toLocaleLowerCase();
  return history.filter((item) =>
    `${item.title} ${item.mode} ${item.status}`.toLocaleLowerCase().includes(normalized),
  );
}

export function historyEmptyLabel(query: string): string {
  return query.trim() === "" ? "Brak zadań" : "Brak pasujących zadań";
}

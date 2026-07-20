import {
  hostToWebviewSchema,
  webviewToHostSchema,
  type AgentViewState,
  type TabId,
  type WebviewToHostMessage,
} from "./messages.js";
import {
  canSubmit,
  filterHistory,
  historyEmptyLabel,
  shouldSubmitKey,
  type PersistedUiState,
} from "./uiModel.js";

interface VsCodeApi { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const byId = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const elements = {
  workspace: byId<HTMLElement>("workspace"), trust: byId<HTMLElement>("trust"), runtime: byId<HTMLElement>("runtime"),
  mode: byId<HTMLSelectElement>("mode"), context: byId<HTMLSelectElement>("context"), messages: byId<HTMLElement>("messages"),
  composer: byId<HTMLFormElement>("composer"), task: byId<HTMLTextAreaElement>("task"), send: byId<HTMLButtonElement>("send"), cancel: byId<HTMLButtonElement>("cancel"),
  taskTitle: byId<HTMLElement>("task-title"), taskPhase: byId<HTMLElement>("task-phase"), taskList: byId<HTMLElement>("task-list"), taskFilter: byId<HTMLInputElement>("task-filter"),
  changeList: byId<HTMLElement>("change-list"), changeStatus: byId<HTMLElement>("change-status"), checkpointList: byId<HTMLElement>("checkpoint-list"),
  verificationSummary: byId<HTMLElement>("verification-summary"), verificationList: byId<HTMLElement>("verification-list"),
  orchestration: byId<HTMLElement>("orchestration-content"), orchestrationActions: byId<HTMLElement>("orchestration-actions"), github: byId<HTMLElement>("github-content"),
  tasksCount: byId<HTMLElement>("tasks-count"), changesCount: byId<HTMLElement>("changes-count"), checkpointCount: byId<HTMLElement>("checkpoint-count"), live: byId<HTMLElement>("status-live"),
};

let state: AgentViewState | undefined;
const stored = vscode.getState() as Partial<PersistedUiState> | null;
const ui: PersistedUiState = {
  activeTab: stored?.activeTab ?? "tasks",
  draft: typeof stored?.draft === "string" ? stored.draft : "",
  taskFilter: typeof stored?.taskFilter === "string" ? stored.taskFilter : "",
};

function emptyState(label: string): HTMLElement { const node = document.createElement("p"); node.className = "empty-state"; node.textContent = label; return node; }

function persist(): void { vscode.setState(ui); }
function send(message: WebviewToHostMessage): void { const parsed = webviewToHostSchema.safeParse(message); if (parsed.success) vscode.postMessage(parsed.data); }
function button(label: string, className = ""): HTMLButtonElement { const node = document.createElement("button"); node.type = "button"; node.textContent = label; node.className = className; return node; }
function line(label: string, value: string): HTMLDivElement { const node = document.createElement("div"); node.className = "data-line"; const key = document.createElement("span"); key.className = "muted"; key.textContent = label; const val = document.createElement("span"); val.textContent = value; node.append(key, val); return node; }
function iconFor(status: string): string { return status === "passed" || status === "completed" ? "✓" : status === "failed" || status.includes("block") ? "!" : status === "cancelled" ? "×" : "○"; }
function relativeTime(value: string): string { const time = new Date(value).getTime(); if (!Number.isFinite(time)) return ""; const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000)); if (minutes < 1) return "teraz"; if (minutes < 60) return `${minutes} min`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours} godz.`; return `${Math.floor(hours / 24)} dni`; }
function setCount(element: HTMLElement | null, count: number): void { if (element === null) return; element.textContent = count === 0 ? "" : String(count); element.hidden = count === 0; }

function switchTab(tab: TabId, focus = false): void {
  ui.activeTab = tab; persist();
  for (const control of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tab]"))) {
    const active = control.dataset.tab === tab; control.setAttribute("aria-selected", String(active)); control.tabIndex = active ? 0 : -1;
    if (active && focus) control.focus();
  }
  for (const panel of Array.from(document.querySelectorAll<HTMLElement>(".tab-panel"))) panel.hidden = panel.id !== `tab-${tab}`;
  if (tab === "chat") requestAnimationFrame(scrollMessages);
}

function addMessage(role: string, content: string): void {
  if (elements.messages === null) return;
  const article = document.createElement("article"); article.className = `message ${role}`;
  const label = document.createElement("span"); label.className = "message-role"; label.textContent = role === "user" ? "Ty" : role === "assistant" ? "Agent" : role === "error" ? "Błąd" : "System";
  const body = document.createElement("div"); body.className = "message-body"; body.textContent = content; article.append(label, body); elements.messages.append(article);
}
function scrollMessages(): void { if (elements.messages !== null) elements.messages.scrollTop = elements.messages.scrollHeight; }

function renderTasks(view: AgentViewState): void {
  setCount(elements.tasksCount, view.history.length);
  if (elements.taskList === null) return; elements.taskList.replaceChildren();
  const query = ui.taskFilter;
  const items = filterHistory(view.history, query);
  if (items.length === 0) { elements.taskList.append(emptyState(historyEmptyLabel(query))); return; }
  for (const item of items) {
    const row = button(""); row.className = "list-row task-row"; row.setAttribute("aria-label", `${item.title}, ${item.mode}, ${item.status}`);
    const status = document.createElement("span"); status.className = "status-icon"; status.textContent = iconFor(item.status); status.setAttribute("aria-hidden", "true");
    const content = document.createElement("span"); content.className = "row-content"; const title = document.createElement("strong"); title.textContent = item.title; const meta = document.createElement("span"); meta.className = "muted"; meta.textContent = `${item.mode} · ${item.status}`; content.append(title, meta);
    const time = document.createElement("time"); time.className = "muted"; time.dateTime = item.createdAt; time.textContent = relativeTime(item.createdAt); row.append(status, content, time);
    row.addEventListener("click", () => { switchTab("chat"); if (elements.taskTitle !== null) elements.taskTitle.textContent = item.title; if (elements.taskPhase !== null) elements.taskPhase.textContent = ` · ${item.mode} · ${item.status}`; if (elements.messages !== null && view.task?.id !== item.id) { elements.messages.replaceChildren(emptyState("Dla tego zadania dostępne są tylko metadane historii.")); } });
    elements.taskList.append(row);
  }
}

function renderChanges(view: AgentViewState): void {
  setCount(elements.changesCount, view.changes.length); setCount(elements.checkpointCount, view.checkpoints.length);
  if (elements.changeStatus !== null) elements.changeStatus.textContent = view.changeStatus ?? "";
  if (elements.changeList !== null) { elements.changeList.replaceChildren(); if (view.changes.length === 0) elements.changeList.append(emptyState("Brak przygotowanych zmian"));
    for (const item of view.changes) { const row = button(""); row.className = "list-row"; const mark = document.createElement("span"); mark.className = `operation ${item.operation}`; mark.textContent = item.operation === "create" ? "+" : item.operation === "delete" ? "−" : item.operation === "move" ? "→" : "±"; const content = document.createElement("span"); content.className = "row-content"; const path = document.createElement("strong"); path.textContent = item.path; const reason = document.createElement("span"); reason.className = "muted"; reason.textContent = item.reason ?? item.operation; content.append(path, reason); row.append(mark, content); row.addEventListener("click", () => send({ type: "diff.open", path: item.path })); elements.changeList.append(row); }
  }
  if (elements.checkpointList !== null) { elements.checkpointList.replaceChildren(); if (view.checkpoints.length === 0) elements.checkpointList.append(emptyState("Brak checkpointów"));
    for (const item of view.checkpoints) { const row = document.createElement("div"); row.className = "list-row static"; const content = document.createElement("span"); content.className = "row-content"; const title = document.createElement("strong"); title.textContent = item.task; const meta = document.createElement("span"); meta.className = "muted"; meta.textContent = `${item.createdAt === undefined ? "" : new Date(item.createdAt).toLocaleString()} · ${item.id.slice(0, 8)}`; content.append(title, meta); const restore = button("Przywróć", "secondary small"); restore.addEventListener("click", () => send({ type: "checkpoint.restore", checkpointId: item.id })); row.append(content, restore); elements.checkpointList.append(row); }
  }
}

function renderVerification(view: AgentViewState): void {
  if (elements.verificationSummary === null || elements.verificationList === null) return; elements.verificationSummary.replaceChildren(); elements.verificationList.replaceChildren(); const report = view.verification;
  if (report === null || report.steps.length === 0) { elements.verificationSummary.append(emptyState("Brak wyników weryfikacji")); return; }
  const summary = document.createElement("div"); summary.className = "summary-line"; summary.append(line("Status", report.status), line("Czas", report.durationMs === undefined ? "—" : `${report.durationMs} ms`), line("Kroki", `${report.passed} OK · ${report.failed} błędów`)); elements.verificationSummary.append(summary);
  for (const step of report.steps) { const details = document.createElement("details"); details.className = `verification-step ${step.status}`; const summaryNode = document.createElement("summary"); summaryNode.textContent = `${iconFor(step.status)} ${step.name} · ${step.status}`; details.append(summaryNode); if (step.details !== undefined) { const pre = document.createElement("pre"); pre.textContent = step.details; details.append(pre); } elements.verificationList.append(details); }
}

function renderOrchestration(view: AgentViewState): void {
  if (elements.orchestration === null) return; elements.orchestration.replaceChildren(); const orchestration = view.orchestration;
  if (orchestration === null) { elements.orchestration.append(emptyState("Brak aktywnej orkiestracji")); if (elements.orchestrationActions !== null) elements.orchestrationActions.hidden = true; return; }
  if (orchestration.securityBlocked) { const alert = document.createElement("div"); alert.className = "error-banner"; alert.setAttribute("role", "alert"); alert.textContent = "! Orkiestracja zatrzymana przez kontrolę bezpieczeństwa"; elements.orchestration.append(alert); }
  elements.orchestration.append(line("Status sesji", orchestration.status), line("Tryb", orchestration.mode), line("Aktualny etap", orchestration.stage));
  const addGroup = (titleText: string, items: typeof orchestration.agents) => { const title = document.createElement("h2"); title.textContent = titleText; const list = document.createElement("div"); list.className = "item-list"; if (items.length === 0) list.append(emptyState("Brak elementów")); for (const item of items) { const row = document.createElement("div"); row.className = "list-row static"; row.textContent = `${iconFor(item.status)} ${item.title} · ${item.status}`; list.append(row); } elements.orchestration?.append(title, list); };
  addGroup("Agenci", orchestration.agents); addGroup("Graf zadań", orchestration.tasks); if (orchestration.reviewStatus !== undefined) elements.orchestration.append(line("Review", orchestration.reviewStatus)); if (elements.orchestrationActions !== null) elements.orchestrationActions.hidden = !orchestration.requiresAction;
}

function renderGitHub(view: AgentViewState): void {
  if (elements.github === null) return; elements.github.replaceChildren(); const github = view.github;
  if (!github.enabled) elements.github.append(emptyState("Integracja GitHub jest wyłączona")); else elements.github.append(line("Status", github.connected ? "Połączono" : "Nie połączono"), line("Konto", github.account ?? "—"), line("Repozytorium", github.repository ?? "—"), line("Uprawnienia", github.permission), line("Pull Request", github.pullRequest ?? "—"), line("Checki", github.checksStatus ?? "—"), line("Limit API", github.apiLimit ?? "—"));
  if (github.error !== undefined) { const alert = document.createElement("div"); alert.className = "error-banner"; alert.setAttribute("role", "alert"); alert.textContent = github.error; elements.github.append(alert); }
  const connect = byId<HTMLButtonElement>("github-connect"); if (connect !== null) { connect.hidden = github.connected; connect.disabled = !github.enabled; }
  for (const id of ["github-refresh", "github-publish", "github-pr"]) { const control = byId<HTMLButtonElement>(id); if (control !== null) control.disabled = !github.enabled; }
}

function render(view: AgentViewState): void {
  state = view; if (elements.workspace !== null) elements.workspace.textContent = view.workspaceLabel || "Local Code Agent"; if (elements.trust !== null) elements.trust.textContent = view.trusted ? " · zaufany" : " · niezaufany"; if (elements.runtime !== null) elements.runtime.textContent = view.runtimeState;
  if (elements.mode !== null) { elements.mode.value = view.mode; for (const option of Array.from(elements.mode.options)) option.disabled = !view.trusted && option.value !== "ask"; }
  if (elements.context !== null) elements.context.value = view.context;
  const active = view.task !== null && !["completed", "failed", "cancelled"].includes(view.task.phase); if (elements.cancel !== null) elements.cancel.hidden = !active; if (elements.taskTitle !== null) elements.taskTitle.textContent = view.task?.title ?? "Nowe zadanie"; if (elements.taskPhase !== null) elements.taskPhase.textContent = view.task === null ? "" : ` · ${view.task.phase}`;
  const runtimeReady = view.runtimeState === "ready"; if (elements.task !== null) elements.task.disabled = !runtimeReady; if (elements.send !== null) elements.send.disabled = !canSubmit(view.runtimeState, elements.task?.value ?? "");
  if (elements.messages !== null) { elements.messages.replaceChildren(); if (view.messages.length === 0) elements.messages.append(emptyState("Rozpocznij nowe zadanie, wpisując polecenie poniżej.")); for (const message of view.messages) addMessage(message.role, message.content); if (view.error !== null) addMessage("error", view.error); requestAnimationFrame(scrollMessages); }
  renderTasks(view); renderChanges(view); renderVerification(view); renderOrchestration(view); renderGitHub(view); if (elements.live !== null) elements.live.textContent = `Runtime: ${view.runtimeState}${view.error === null ? "" : `. Błąd: ${view.error}`}`;
}

function resizeComposer(): void { if (elements.task === null) return; elements.task.style.height = "auto"; elements.task.style.height = `${Math.min(elements.task.scrollHeight, 180)}px`; if (elements.send !== null) elements.send.disabled = state === undefined || !canSubmit(state.runtimeState, elements.task.value); ui.draft = elements.task.value; persist(); }

document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((control) => control.addEventListener("click", () => switchTab(control.dataset.tab as TabId)));
byId<HTMLElement>("tabs")?.addEventListener("keydown", (event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tab]")); const current = tabs.findIndex((tab) => tab.dataset.tab === ui.activeTab); const delta = event.key === "ArrowRight" ? 1 : -1; switchTab(tabs[(current + delta + tabs.length) % tabs.length]?.dataset.tab as TabId, true); });
elements.composer?.addEventListener("submit", (event) => { event.preventDefault(); const task = elements.task?.value.trim() ?? ""; if (task === "" || elements.mode === null || elements.context === null || state?.runtimeState !== "ready") return; send({ type: "task.submit", task, mode: elements.mode.value as AgentViewState["mode"], context: elements.context.value as AgentViewState["context"] }); if (elements.task !== null) { elements.task.value = ""; resizeComposer(); } });
elements.task?.addEventListener("input", resizeComposer); elements.task?.addEventListener("keydown", (event) => { if (shouldSubmitKey(event.key, event.shiftKey)) { event.preventDefault(); elements.composer?.requestSubmit(); } });
elements.mode?.addEventListener("change", () => send({ type: "mode.change", mode: elements.mode?.value as AgentViewState["mode"] })); elements.context?.addEventListener("change", () => send({ type: "context.change", context: elements.context?.value as AgentViewState["context"] }));
elements.taskFilter?.addEventListener("input", () => { ui.taskFilter = elements.taskFilter?.value ?? ""; persist(); if (state !== undefined) renderTasks(state); });
byId<HTMLButtonElement>("new-task")?.addEventListener("click", () => { switchTab("chat"); elements.task?.focus(); }); elements.cancel?.addEventListener("click", () => send({ type: "task.cancel" }));
const actions: Array<[string, WebviewToHostMessage]> = [["preview", { type: "changes.preview" }], ["apply", { type: "changes.apply" }], ["reject", { type: "changes.reject" }], ["verify", { type: "verification.run" }], ["settings", { type: "settings.open" }], ["logs", { type: "logs.open" }], ["restart", { type: "runtime.restart" }], ["orchestration-approve", { type: "orchestration.approve" }], ["orchestration-reject", { type: "orchestration.reject" }], ["github-connect", { type: "github.action", action: "connect" }], ["github-refresh", { type: "github.action", action: "refresh" }], ["github-publish", { type: "github.action", action: "publish" }], ["github-pr", { type: "github.action", action: "draftPr" }]];
for (const [id, message] of actions) byId<HTMLButtonElement>(id)?.addEventListener("click", () => send(message));
window.addEventListener("message", (event: MessageEvent<unknown>) => { const parsed = hostToWebviewSchema.safeParse(event.data); if (!parsed.success) return; const message = parsed.data; if (message.type === "state.initial" || message.type === "state.updated") render(message.state); else if (message.type === "agent.message") { addMessage(message.role, message.content); scrollMessages(); } else if (message.type === "error.show") { addMessage("error", `${message.code === undefined ? "" : `${message.code}: `}${message.message}`); scrollMessages(); } else if (message.type === "runtime.updated" && elements.runtime !== null) elements.runtime.textContent = message.state; });

if (elements.task !== null) elements.task.value = ui.draft; if (elements.taskFilter !== null) elements.taskFilter.value = ui.taskFilter; resizeComposer(); switchTab(ui.activeTab); send({ type: "webview.ready" });

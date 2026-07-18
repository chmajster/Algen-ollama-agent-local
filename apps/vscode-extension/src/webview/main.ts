import {
  hostToWebviewSchema,
  webviewToHostSchema,
  type AgentViewState,
  type WebviewToHostMessage,
} from "./messages.js";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const elements = {
  workspace: document.querySelector<HTMLSpanElement>("#workspace"),
  runtime: document.querySelector<HTMLSpanElement>("#runtime"),
  mode: document.querySelector<HTMLSelectElement>("#mode"),
  context: document.querySelector<HTMLSelectElement>("#context"),
  messages: document.querySelector<HTMLElement>("#messages"),
  summary: document.querySelector<HTMLElement>("#summary"),
  composer: document.querySelector<HTMLFormElement>("#composer"),
  task: document.querySelector<HTMLTextAreaElement>("#task"),
  cancel: document.querySelector<HTMLButtonElement>("#cancel"),
  preview: document.querySelector<HTMLButtonElement>("#preview"),
  apply: document.querySelector<HTMLButtonElement>("#apply"),
  reject: document.querySelector<HTMLButtonElement>("#reject"),
  verify: document.querySelector<HTMLButtonElement>("#verify"),
  settings: document.querySelector<HTMLButtonElement>("#settings"),
};

function send(message: WebviewToHostMessage): void {
  const parsed = webviewToHostSchema.safeParse(message);
  if (parsed.success) vscode.postMessage(parsed.data);
}

function addMessage(role: string, content: string): void {
  if (elements.messages === null) return;
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const label = document.createElement("strong");
  label.textContent = role === "user" ? "Ty" : role === "assistant" ? "Agent" : "System";
  const body = document.createElement("pre");
  body.textContent = content;
  article.append(label, body);
  elements.messages.append(article);
}

function render(state: AgentViewState): void {
  if (elements.workspace !== null)
    elements.workspace.textContent =
      state.workspaceLabel === ""
        ? ""
        : ` · ${state.workspaceLabel}${state.trusted ? "" : " (niezaufany)"}`;
  if (elements.runtime !== null) elements.runtime.textContent = state.runtimeState;
  if (elements.mode !== null) {
    elements.mode.value = state.mode;
    for (const option of Array.from(elements.mode.options)) {
      option.disabled = !state.trusted && option.value !== "ask";
    }
  }
  if (elements.context !== null) elements.context.value = state.context;
  if (elements.cancel !== null)
    elements.cancel.hidden =
      state.task === null || ["completed", "failed", "cancelled"].includes(state.task.phase);
  if (elements.messages !== null) {
    elements.messages.replaceChildren();
    for (const message of state.messages) addMessage(message.role, message.content);
  }
  if (elements.summary !== null) {
    const parts: string[] = [];
    if (state.task !== null) parts.push(`Zadanie: ${state.task.phase}`);
    if (state.changes !== null) parts.push(`Zmiany: ${String(state.changes.status ?? "gotowe")}`);
    if (state.verification !== null)
      parts.push(`Weryfikacja: ${String(state.verification.status ?? "gotowa")}`);
    if (state.error !== null) parts.push(`Błąd: ${state.error}`);
    elements.summary.hidden = parts.length === 0;
    elements.summary.textContent = parts.join(" · ");
  }
  vscode.setState({ mode: state.mode, context: state.context });
}

elements.composer?.addEventListener("submit", (event) => {
  event.preventDefault();
  const task = elements.task?.value.trim() ?? "";
  if (task === "" || elements.mode === null || elements.context === null) return;
  send({
    type: "task.submit",
    task,
    mode: elements.mode.value as AgentViewState["mode"],
    context: elements.context.value as AgentViewState["context"],
  });
  addMessage("user", task);
  if (elements.task !== null) elements.task.value = "";
});
elements.mode?.addEventListener("change", () =>
  send({ type: "mode.change", mode: elements.mode?.value as AgentViewState["mode"] }),
);
elements.context?.addEventListener("change", () =>
  send({ type: "context.change", context: elements.context?.value as AgentViewState["context"] }),
);
elements.cancel?.addEventListener("click", () => send({ type: "task.cancel" }));
elements.preview?.addEventListener("click", () => send({ type: "changes.preview" }));
elements.apply?.addEventListener("click", () => send({ type: "changes.apply" }));
elements.reject?.addEventListener("click", () => send({ type: "changes.reject" }));
elements.verify?.addEventListener("click", () => send({ type: "verification.run" }));
elements.settings?.addEventListener("click", () => send({ type: "settings.open" }));

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const parsed = hostToWebviewSchema.safeParse(event.data);
  if (!parsed.success) return;
  const message = parsed.data;
  if (message.type === "state.initial" || message.type === "state.updated") render(message.state);
  else if (message.type === "agent.message") addMessage(message.role, message.content);
  else if (message.type === "error.show")
    addMessage(
      "system",
      `${message.code === undefined ? "" : `${message.code}: `}${message.message}`,
    );
  else if (message.type === "runtime.updated" && elements.runtime !== null)
    elements.runtime.textContent = message.state;
});

send({ type: "webview.ready" });

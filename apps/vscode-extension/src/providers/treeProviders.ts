import * as vscode from "vscode";

import type { TaskHistoryItem } from "../history/historyService.js";

export interface AgentTreeData {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  icon?: string;
  command?: vscode.Command;
  data?: unknown;
  children?: AgentTreeData[];
}

export class AgentTreeItem extends vscode.TreeItem {
  public constructor(public readonly model: AgentTreeData) {
    super(
      model.label,
      model.children === undefined || model.children.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.id = model.id;
    if (model.description !== undefined) this.description = model.description;
    if (model.tooltip !== undefined) this.tooltip = model.tooltip;
    if (model.contextValue !== undefined) this.contextValue = model.contextValue;
    if (model.command !== undefined) this.command = model.command;
    if (model.icon !== undefined) this.iconPath = new vscode.ThemeIcon(model.icon);
  }
}

export class AgentTreeProvider
  implements vscode.TreeDataProvider<AgentTreeItem>, vscode.Disposable
{
  private items: AgentTreeItem[] = [];
  private readonly changed = new vscode.EventEmitter<AgentTreeItem | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;

  public getTreeItem(element: AgentTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: AgentTreeItem): AgentTreeItem[] {
    return element === undefined
      ? this.items
      : (element.model.children ?? []).map((item) => new AgentTreeItem(item));
  }

  public update(items: AgentTreeData[]): void {
    this.items = items.map((item) => new AgentTreeItem(item));
    this.changed.fire(undefined);
  }

  public dispose(): void {
    this.changed.dispose();
  }
}

export function orchestrationTreeItems(value: unknown): AgentTreeData[] {
  const data = record(value);
  const session = record(data?.session);
  if (session === undefined) {
    return [{ id: "orchestration-empty", label: "Brak aktywnej orkiestracji", icon: "info" }];
  }
  const graph = record(data?.graph);
  const nodes = Array.isArray(graph?.nodes)
    ? graph.nodes.map(record).filter((item) => item !== undefined)
    : [];
  const agents = Array.isArray(data?.agents)
    ? data.agents.map(record).filter((item) => item !== undefined)
    : [];
  const review = record(data?.review);
  return [
    {
      id: `orchestration-${String(session.id)}`,
      label: `Session — ${String(session.state ?? "unknown")}`,
      description: String(session.mode ?? ""),
      icon:
        session.state === "completed"
          ? "pass"
          : session.state === "security_stopped"
            ? "error"
            : "organization",
      children: [
        {
          id: "orchestration-graph",
          label: "Task graph",
          icon: "type-hierarchy",
          children: nodes.map((node) => ({
            id: `node-${String(node.id)}`,
            label: String(node.title ?? node.id),
            description: String(node.status ?? "pending"),
            icon:
              node.status === "completed"
                ? "pass"
                : node.status === "failed"
                  ? "error"
                  : "circle-outline",
          })),
        },
        {
          id: "orchestration-agents",
          label: "Agents",
          icon: "hubot",
          children: agents.map((agent) => ({
            id: `agent-${String(agent.id)}`,
            label: String(agent.role ?? agent.id),
            description: String(agent.status ?? "created"),
            icon:
              agent.status === "completed" ? "pass" : agent.status === "failed" ? "error" : "sync",
          })),
        },
        {
          id: "orchestration-review",
          label: `Review — ${String(review?.status ?? "pending")}`,
          icon: review?.status === "security_blocked" ? "shield" : "checklist",
        },
      ],
    },
  ];
}

export function githubTreeItems(value: unknown): AgentTreeData[] {
  const status = record(value);
  if (status?.enabled !== true) {
    return [
      { id: "github-disabled", label: "Integracja GitHub jest wyłączona", icon: "circle-slash" },
    ];
  }
  const user = record(status.user);
  const repository = record(status.repository);
  const permissions = record(status.permissions);
  const items: AgentTreeData[] = [
    {
      id: "github-account",
      label: `Account: ${typeof user?.login === "string" ? user.login : "not connected"}`,
      icon: user === undefined ? "account" : "github",
      command:
        user === undefined
          ? { command: "localCodeAgent.github.connect", title: "Connect GitHub" }
          : { command: "localCodeAgent.github.showAccount", title: "Show account" },
    },
    {
      id: "github-repository",
      label: `Repository: ${typeof repository?.owner === "string" ? `${repository.owner}/${String(repository.repository)}` : "not verified"}`,
      icon: repository?.verified === true ? "verified" : "repo",
      command: { command: "localCodeAgent.github.verifyRepository", title: "Verify repository" },
    },
    {
      id: "github-permissions",
      label: `Permissions: ${permissions?.write === true ? "Write" : permissions?.read === true ? "Read" : "Unknown"}`,
      icon: "key",
    },
    {
      id: "github-pull-requests",
      label: "Pull Requests",
      icon: "git-pull-request",
      children: [{ id: "github-pr-empty", label: "Brak powiązanego PR", icon: "info" }],
    },
  ];
  return items;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function changeTreeItems(value: unknown): AgentTreeData[] {
  const changes = record(value);
  const operations = Array.isArray(changes?.operations) ? changes.operations : [];
  if (operations.length === 0)
    return [{ id: "changes-empty", label: "Brak przygotowanych zmian", icon: "info" }];
  return operations.flatMap((operation, index) => {
    const item = record(operation);
    if (item === undefined) return [];
    const path = String(item.path ?? item.destinationPath ?? item.sourcePath ?? "nieznany plik");
    return [
      {
        id: String(item.id ?? `change-${index}`),
        label: path,
        description: String(item.type ?? "zmiana"),
        ...(typeof item.reason === "string" ? { tooltip: item.reason } : {}),
        contextValue: "localCodeAgent.change",
        icon:
          item.type === "create_file" ? "new-file" : item.type === "delete_file" ? "trash" : "diff",
        data: { path },
        command: { command: "localCodeAgent.showDiff", title: "Pokaż diff", arguments: [{ path }] },
      },
    ];
  });
}

export function checkpointTreeItems(value: unknown): AgentTreeData[] {
  const checkpoints = Array.isArray(value) ? value : [];
  if (checkpoints.length === 0)
    return [{ id: "checkpoints-empty", label: "Brak checkpointów", icon: "info" }];
  return checkpoints.flatMap((checkpoint) => {
    const item = record(checkpoint);
    if (item === undefined || typeof item.id !== "string") return [];
    return [
      {
        id: item.id,
        label: typeof item.task === "string" ? item.task : `Checkpoint ${item.id.slice(0, 8)}`,
        ...(typeof item.createdAt === "string"
          ? { description: new Date(item.createdAt).toLocaleString() }
          : {}),
        contextValue: "localCodeAgent.checkpoint",
        icon: "history",
        data: item,
        command: {
          command: "localCodeAgent.restoreCheckpoint",
          title: "Przywróć checkpoint",
          arguments: [item],
        },
      },
    ];
  });
}

export function verificationTreeItems(value: unknown): AgentTreeData[] {
  const report = record(value);
  if (report === undefined)
    return [{ id: "verification-empty", label: "Brak wyników weryfikacji", icon: "info" }];
  const steps = Array.isArray(report.steps) ? report.steps : [];
  return [
    {
      id: `verification-${String(report.id ?? "current")}`,
      label: `Wynik: ${String(report.status ?? "nieznany")}`,
      ...(typeof report.durationMs === "number" ? { description: `${report.durationMs} ms` } : {}),
      icon: report.status === "passed" ? "pass" : report.status === "failed" ? "error" : "warning",
    },
    ...steps.flatMap((step, index) => {
      const item = record(step);
      if (item === undefined) return [];
      return [
        {
          id: `verification-step-${String(item.commandId ?? index)}`,
          label: String(item.displayName ?? item.commandId ?? "Krok"),
          description: String(item.status ?? ""),
          icon:
            item.status === "passed"
              ? "pass"
              : item.status === "failed"
                ? "error"
                : "circle-outline",
        },
      ];
    }),
  ];
}

export function historyTreeItems(items: TaskHistoryItem[]): AgentTreeData[] {
  if (items.length === 0)
    return [{ id: "history-empty", label: "Brak historii zadań", icon: "info" }];
  return items.map((item) => ({
    id: `history-${item.id}`,
    label: item.promptSummary,
    description: `${item.mode} · ${item.status}`,
    tooltip: `${new Date(item.createdAt).toLocaleString()} · pliki: ${item.filesChanged}`,
    icon:
      item.status === "failed" ? "error" : item.status === "cancelled" ? "circle-slash" : "history",
    data: item,
  }));
}

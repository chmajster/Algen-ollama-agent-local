import type * as vscode from "vscode";

export interface TaskHistoryItem {
  id: string;
  createdAt: string;
  promptSummary: string;
  mode: string;
  status: string;
  filesChanged: number;
  verificationStatus?: string;
}

const HISTORY_KEY = "localCodeAgent.taskHistory";

export class HistoryService {
  public constructor(
    private readonly state: vscode.Memento,
    private readonly enabled: () => boolean,
    private readonly maxItems: () => number,
  ) {}

  public list(): TaskHistoryItem[] {
    if (!this.enabled()) return [];
    return this.state.get<TaskHistoryItem[]>(HISTORY_KEY, []).slice(0, this.maxItems());
  }

  public async add(item: TaskHistoryItem): Promise<void> {
    if (!this.enabled()) return;
    const safe: TaskHistoryItem = {
      ...item,
      promptSummary: item.promptSummary.replace(/\s+/gu, " ").trim().slice(0, 160),
    };
    await this.state.update(
      HISTORY_KEY,
      [safe, ...this.list().filter((entry) => entry.id !== safe.id)].slice(0, this.maxItems()),
    );
  }

  public async clear(): Promise<void> {
    await this.state.update(HISTORY_KEY, []);
  }
}

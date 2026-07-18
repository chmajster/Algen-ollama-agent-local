import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { OrchestrationAuditEntry } from "./orchestrationTypes.js";

const SECRET = /\b(?:gh[opurs]_|github_pat_|bearer\s+|password=|token=)[^\s"]+/gi;

export class OrchestrationAuditService {
  public constructor(private readonly file?: string) {}

  public async record(entry: OrchestrationAuditEntry): Promise<void> {
    if (this.file === undefined) return;
    await mkdir(dirname(this.file), { recursive: true });
    const safe = JSON.stringify(entry).replace(SECRET, "[REDACTED]");
    await appendFile(this.file, `${safe}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

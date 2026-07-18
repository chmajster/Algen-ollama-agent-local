import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { safeRemoteMessage } from "./errors.js";
import type { RemoteOperationAuditEntry } from "./remoteRepositoryTypes.js";

export class RemoteAuditService {
  public constructor(private readonly path: string) {}

  public async record(entry: RemoteOperationAuditEntry): Promise<void> {
    const safe: RemoteOperationAuditEntry = {
      ...entry,
      ...(entry.repository === undefined
        ? {}
        : { repository: safeRemoteMessage(entry.repository) }),
      ...(entry.errorCode === undefined ? {} : { errorCode: safeRemoteMessage(entry.errorCode) }),
    };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

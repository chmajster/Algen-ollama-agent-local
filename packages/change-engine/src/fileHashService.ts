import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

export class FileHashService {
  public hashBytes(value: Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
  }

  public hashText(value: string): string {
    return this.hashBytes(Buffer.from(value, "utf8"));
  }

  public async hashFile(path: string): Promise<string> {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    try {
      for await (const chunk of stream) {
        hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      return hash.digest("hex");
    } finally {
      stream.destroy();
    }
  }
}

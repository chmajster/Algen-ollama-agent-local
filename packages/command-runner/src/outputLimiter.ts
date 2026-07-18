import type { OutputLimits } from "./commandTypes.js";

const marker = (omitted: number, unit: string): string =>
  `\n[... pominięto ${omitted} ${unit} wyjścia ...]\n`;

function limitText(
  value: string,
  limit: number,
  unit: string,
): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  const notice = marker(value.length - limit, unit);
  const available = Math.max(0, limit - notice.length);
  const beginning = Math.ceil(available / 2);
  return {
    text: value.slice(0, beginning) + notice + value.slice(-(available - beginning)),
    truncated: true,
  };
}

function limitLines(value: string, limit: number): { text: string; truncated: boolean } {
  const lines = value.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  if (lines.length <= limit) return { text: value, truncated: false };
  const keep = Math.max(0, limit - 1);
  const beginning = Math.ceil(keep / 2);
  return {
    text:
      lines.slice(0, beginning).join("") +
      `[... pominięto ${lines.length - keep} linii wyjścia ...]\n` +
      lines.slice(-Math.floor(keep / 2)).join(""),
    truncated: true,
  };
}

export interface LimitedOutput {
  text: string;
  truncated: boolean;
  bytes: number;
}

function decodeTruncatedHead(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(value, { stream: true });
}

function decodeTruncatedTail(value: Uint8Array): string {
  let offset = 0;
  while (offset < value.length && (value[offset]! & 0xc0) === 0x80) offset += 1;
  return new TextDecoder("utf-8", { fatal: false }).decode(value.subarray(offset));
}

export class OutputLimiter {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private totalBytes = 0;

  public constructor(private readonly limits: OutputLimits) {
    this.headLimit = Math.ceil(limits.maxBytes / 2);
    this.tailLimit = Math.floor(limits.maxBytes / 2);
  }

  public append(chunk: Uint8Array | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    this.totalBytes += bytes.length;
    let remainder = bytes;
    if (this.head.length < this.headLimit) {
      const needed = this.headLimit - this.head.length;
      this.head = Buffer.concat([this.head, remainder.subarray(0, needed)]);
      remainder = remainder.subarray(Math.min(needed, remainder.length));
    }
    if (remainder.length > 0 && this.tailLimit > 0) {
      this.tail = Buffer.concat([this.tail, remainder]);
      if (this.tail.length > this.tailLimit)
        this.tail = this.tail.subarray(this.tail.length - this.tailLimit);
    }
  }

  public result(): LimitedOutput {
    const byteTruncated = this.totalBytes > this.limits.maxBytes;
    let text = byteTruncated
      ? decodeTruncatedHead(this.head)
      : new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat([this.head, this.tail]));
    if (byteTruncated && this.tail.length > 0) {
      text += marker(this.totalBytes - this.head.length - this.tail.length, "bajtów");
      text += decodeTruncatedTail(this.tail);
    }
    const lineLimited = limitLines(text, this.limits.maxLines);
    const charLimited = limitText(lineLimited.text, this.limits.maxChars, "znaków");
    return {
      text: charLimited.text,
      truncated: byteTruncated || lineLimited.truncated || charLimited.truncated,
      bytes: this.totalBytes,
    };
  }
}

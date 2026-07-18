import { extname } from "node:path";
import { open } from "node:fs/promises";

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".class",
  ".jar",
  ".war",
  ".woff",
  ".woff2",
  ".ttf",
  ".mp3",
  ".mp4",
  ".mkv",
  ".avi",
  ".sqlite",
  ".db",
]);

export function hasBinaryExtension(path: string): boolean {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

export function bufferLooksBinary(buffer: Uint8Array): boolean {
  if (buffer.includes(0)) {
    return true;
  }

  let suspiciousBytes = 0;
  for (const byte of buffer) {
    const allowedControl = byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if ((byte < 32 && !allowedControl) || byte === 127) {
      suspiciousBytes += 1;
    }
  }
  return buffer.length > 0 && suspiciousBytes / buffer.length > 0.1;
}

export async function isBinaryFile(path: string): Promise<boolean> {
  if (hasBinaryExtension(path)) {
    return true;
  }

  const handle = await open(path, "r");
  try {
    const sample = Buffer.alloc(8_192);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    return bufferLooksBinary(sample.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

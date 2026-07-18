import {
  EmptyPatchError,
  OverlappingPatchError,
  PatchOccurrenceMismatchError,
  PatchTargetNotFoundError,
  UnsupportedWriteEncodingError,
} from "./errors.js";
import { FileHashService } from "./fileHashService.js";
import type { TextPatch } from "./changeTypes.js";

interface ReplacementInterval {
  start: number;
  end: number;
  newText: string;
}

interface LineInterval {
  start: number;
  end: number;
}

export interface PatchResult {
  content: string;
  bytes: Uint8Array;
  oldHash: string;
  newHash: string;
  hadBom: boolean;
  eol: "lf" | "crlf";
}

function decodeText(bytes: Uint8Array, path: string): { text: string; hadBom: boolean } {
  const hadBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(hadBom ? bytes.subarray(3) : bytes),
      hadBom,
    };
  } catch (error: unknown) {
    throw new UnsupportedWriteEncodingError(undefined, path, { cause: error });
  }
}

function detectEol(text: string): "lf" | "crlf" {
  return text.includes("\r\n") ? "crlf" : "lf";
}

function normalizeEol(text: string, eol: "lf" | "crlf"): string {
  return text.replace(/\r\n|\r|\n/gu, eol === "crlf" ? "\r\n" : "\n");
}

function occurrences(text: string, target: string): number[] {
  if (target === "") return [];
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= text.length - target.length) {
    const index = text.indexOf(target, offset);
    if (index < 0) break;
    indexes.push(index);
    offset = index + target.length;
  }
  return indexes;
}

function lineIntervals(text: string): LineInterval[] {
  const lines: LineInterval[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "\n" && character !== "\r") continue;
    const endingLength = character === "\r" && text[index + 1] === "\n" ? 2 : 1;
    lines.push({ start, end: index + endingLength });
    start = index + endingLength;
    index += endingLength - 1;
  }
  if (start < text.length) lines.push({ start, end: text.length });
  return lines;
}

function encodedResult(text: string, hadBom: boolean): Uint8Array {
  const content = Buffer.from(text, "utf8");
  return hadBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), content]) : content;
}

export class PatchEngine {
  public constructor(private readonly hashes = new FileHashService()) {}

  public apply(bytes: Uint8Array, patch: TextPatch, path = "plik"): PatchResult {
    const rangeReplacements = patch.lineRangeReplacements ?? [];
    if (patch.replacements.length === 0 && rangeReplacements.length === 0) {
      throw new EmptyPatchError(undefined, path);
    }

    const decoded = decodeText(bytes, path);
    const eol = detectEol(decoded.text);
    const intervals: ReplacementInterval[] = [];

    for (const replacement of patch.replacements) {
      if (replacement.oldText === "") {
        throw new EmptyPatchError("Patch nie może wyszukiwać pustego fragmentu.", path);
      }
      const oldText = normalizeEol(replacement.oldText, eol);
      const newText = normalizeEol(replacement.newText, eol);
      const found = occurrences(decoded.text, oldText);
      const expected = replacement.expectedOccurrences ?? 1;
      if (found.length === 0) {
        throw new PatchTargetNotFoundError(undefined, path);
      }
      if (found.length !== expected) {
        throw new PatchOccurrenceMismatchError(
          `Fragment wskazany przez patch występuje ${found.length} razy, oczekiwano ${expected}.`,
          path,
        );
      }
      for (const start of found) {
        intervals.push({ start, end: start + oldText.length, newText });
      }
    }

    const lines = lineIntervals(decoded.text);
    for (const replacement of rangeReplacements) {
      if (
        replacement.startLine < 1 ||
        replacement.endLine < replacement.startLine ||
        replacement.endLine > lines.length
      ) {
        throw new PatchTargetNotFoundError("Zakres patcha nie istnieje w pliku.", path);
      }
      const first = lines[replacement.startLine - 1];
      const last = lines[replacement.endLine - 1];
      if (first === undefined || last === undefined) {
        throw new PatchTargetNotFoundError("Zakres patcha nie istnieje w pliku.", path);
      }
      const oldText = decoded.text.slice(first.start, last.end);
      if (this.hashes.hashText(oldText) !== replacement.oldTextHash) {
        throw new PatchOccurrenceMismatchError(
          "Hash fragmentu wskazanego przez patch zakresowy jest nieprawidłowy.",
          path,
        );
      }
      intervals.push({
        start: first.start,
        end: last.end,
        newText: normalizeEol(replacement.newText, eol),
      });
    }

    intervals.sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < intervals.length; index += 1) {
      const previous = intervals[index - 1];
      const current = intervals[index];
      if (previous !== undefined && current !== undefined && current.start < previous.end) {
        throw new OverlappingPatchError(undefined, path);
      }
    }

    let content = decoded.text;
    for (const interval of [...intervals].sort((left, right) => right.start - left.start)) {
      content = content.slice(0, interval.start) + interval.newText + content.slice(interval.end);
    }
    if (content === decoded.text) {
      throw new EmptyPatchError("Patch nie powoduje żadnej zmiany.", path);
    }
    const resultBytes = encodedResult(content, decoded.hadBom);
    return {
      content,
      bytes: resultBytes,
      oldHash: this.hashes.hashBytes(bytes),
      newHash: this.hashes.hashBytes(resultBytes),
      hadBom: decoded.hadBom,
      eol,
    };
  }
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EmptyPatchError,
  FileHashService,
  OverlappingPatchError,
  PatchEngine,
  PatchOccurrenceMismatchError,
  PatchTargetNotFoundError,
  UnsupportedWriteEncodingError,
} from "../src/index.js";

describe("FileHashService", () => {
  let root: string;
  const hashes = new FileHashService();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "change-hash-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("zwraca stabilny SHA-256 pliku", async () => {
    const path = join(root, "a.txt");
    await writeFile(path, "abc");
    await expect(hashes.hashFile(path)).resolves.toBe(hashes.hashText("abc"));
  });

  it("zmienia hash po zmianie zawartości", () => {
    expect(hashes.hashText("a")).not.toBe(hashes.hashText("b"));
  });

  it("uwzględnia BOM", () => {
    expect(hashes.hashBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).not.toBe(hashes.hashText("a"));
  });

  it("uwzględnia zakończenia linii", () => {
    expect(hashes.hashText("a\n")).not.toBe(hashes.hashText("a\r\n"));
  });
});

describe("PatchEngine", () => {
  const engine = new PatchEngine();
  const hashes = new FileHashService();

  it("stosuje pojedynczą zamianę", () => {
    const result = engine.apply(Buffer.from("const a = 1;\n"), {
      replacements: [{ oldText: "a = 1", newText: "a = 2" }],
    });
    expect(result.content).toBe("const a = 2;\n");
  });

  it("stosuje kilka rozłącznych zamian", () => {
    const result = engine.apply(Buffer.from("a b c"), {
      replacements: [
        { oldText: "a", newText: "A" },
        { oldText: "c", newText: "C" },
      ],
    });
    expect(result.content).toBe("A b C");
  });

  it("odrzuca brak szukanego fragmentu", () => {
    expect(() =>
      engine.apply(Buffer.from("abc"), {
        replacements: [{ oldText: "x", newText: "y" }],
      }),
    ).toThrow(PatchTargetNotFoundError);
  });

  it("odrzuca więcej wystąpień niż oczekiwano", () => {
    expect(() =>
      engine.apply(Buffer.from("a a"), {
        replacements: [{ oldText: "a", newText: "b" }],
      }),
    ).toThrow(PatchOccurrenceMismatchError);
  });

  it("odrzuca mniej wystąpień niż oczekiwano", () => {
    expect(() =>
      engine.apply(Buffer.from("a"), {
        replacements: [{ oldText: "a", newText: "b", expectedOccurrences: 2 }],
      }),
    ).toThrow(PatchOccurrenceMismatchError);
  });

  it("zmienia wszystkie jawnie oczekiwane wystąpienia", () => {
    const result = engine.apply(Buffer.from("a a"), {
      replacements: [{ oldText: "a", newText: "b", expectedOccurrences: 2 }],
    });
    expect(result.content).toBe("b b");
  });

  it("odrzuca nakładające się zamiany", () => {
    expect(() =>
      engine.apply(Buffer.from("abc"), {
        replacements: [
          { oldText: "abc", newText: "x" },
          { oldText: "bc", newText: "y" },
        ],
      }),
    ).toThrow(OverlappingPatchError);
  });

  it("odrzuca pusty patch", () => {
    expect(() => engine.apply(Buffer.from("abc"), { replacements: [] })).toThrow(EmptyPatchError);
  });

  it("odrzuca patch bez rzeczywistej zmiany", () => {
    expect(() =>
      engine.apply(Buffer.from("abc"), {
        replacements: [{ oldText: "abc", newText: "abc" }],
      }),
    ).toThrow(EmptyPatchError);
  });

  it("zachowuje LF", () => {
    const result = engine.apply(Buffer.from("a\nb\n"), {
      replacements: [{ oldText: "b", newText: "B\nC" }],
    });
    expect(result.content).toBe("a\nB\nC\n");
    expect(result.eol).toBe("lf");
  });

  it("zachowuje CRLF", () => {
    const result = engine.apply(Buffer.from("a\r\nb\r\n"), {
      replacements: [{ oldText: "b", newText: "B\nC" }],
    });
    expect(result.content).toBe("a\r\nB\r\nC\r\n");
    expect(result.eol).toBe("crlf");
  });

  it("zachowuje UTF-8 BOM", () => {
    const result = engine.apply(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a")]),
      {
        replacements: [{ oldText: "a", newText: "b" }],
      },
    );
    expect([...result.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(result.hadBom).toBe(true);
  });

  it("stosuje patch zakresowy po zgodnym hashu fragmentu", () => {
    const content = "one\ntwo\nthree\n";
    const result = engine.apply(Buffer.from(content), {
      replacements: [],
      lineRangeReplacements: [
        { startLine: 2, endLine: 2, oldTextHash: hashes.hashText("two\n"), newText: "TWO\n" },
      ],
    });
    expect(result.content).toBe("one\nTWO\nthree\n");
  });

  it("odrzuca patch zakresowy z błędnym hashem", () => {
    expect(() =>
      engine.apply(Buffer.from("one\ntwo\n"), {
        replacements: [],
        lineRangeReplacements: [
          { startLine: 2, endLine: 2, oldTextHash: "0".repeat(64), newText: "TWO\n" },
        ],
      }),
    ).toThrow(PatchOccurrenceMismatchError);
  });

  it("odrzuca nieistniejący zakres", () => {
    expect(() =>
      engine.apply(Buffer.from("one\n"), {
        replacements: [],
        lineRangeReplacements: [
          { startLine: 2, endLine: 2, oldTextHash: hashes.hashText(""), newText: "two" },
        ],
      }),
    ).toThrow(PatchTargetNotFoundError);
  });

  it("odrzuca niepoprawne UTF-8", () => {
    expect(() =>
      engine.apply(Buffer.from([0xc3, 0x28]), {
        replacements: [{ oldText: "a", newText: "b" }],
      }),
    ).toThrow(UnsupportedWriteEncodingError);
  });

  it("zwraca hash surowych bajtów przed i po zmianie", () => {
    const source = Buffer.from("a\r\n");
    const result = engine.apply(source, {
      replacements: [{ oldText: "a", newText: "b" }],
    });
    expect(result.oldHash).toBe(hashes.hashBytes(source));
    expect(result.newHash).toBe(hashes.hashBytes(result.bytes));
  });
});

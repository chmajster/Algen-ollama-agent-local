import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bufferLooksBinary, hasBinaryExtension, isBinaryFile } from "../src/index.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "workspace-binary-"));
  await mkdir(directory, { recursive: true });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("binaryDetector", () => {
  it("rozpoznaje znane rozszerzenie binarne", () => {
    expect(hasBinaryExtension("assets/logo.PNG")).toBe(true);
  });

  it("nie klasyfikuje rozszerzenia tekstowego jako binarnego", () => {
    expect(hasBinaryExtension("src/index.ts")).toBe(false);
  });

  it("wykrywa bajt NUL niezależnie od rozszerzenia", async () => {
    const path = join(directory, "data.txt");
    await writeFile(path, Buffer.from([65, 66, 0, 67]));
    await expect(isBinaryFile(path)).resolves.toBe(true);
  });

  it("akceptuje zwykły tekst UTF-8", async () => {
    const path = join(directory, "text.txt");
    await writeFile(path, "Zażółć gęślą jaźń\n", "utf8");
    await expect(isBinaryFile(path)).resolves.toBe(false);
    expect(bufferLooksBinary(Buffer.from("tekst"))).toBe(false);
  });
});
